/**
 * admin.mjs —— 管理端。仅调用 /api/admin/*（需令牌）；坐标录入支持 WGS84/GCJ02 选择。
 */
const API = '/api/admin';
let token = sessionStorage.getItem('vmap_admin_token') || '';
let state = null;

const $ = (id) => document.getElementById(id);

async function api(path, opts = {}) {
    const res = await fetch(API + path, {
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-admin-token': token },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) {
        sessionStorage.removeItem('vmap_admin_token');
        $('admin-panel').hidden = true;
        $('login-card').hidden = false;
        throw new Error('令牌无效，请重新登录');
    }
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
}

async function refresh() {
    state = await api('/state');
    renderAll();
}

function renderAll() {
    renderPublishBar();
    renderEventForm();
    renderOrgs();
    renderPhotoEvents();
    renderStateTable();
}

function renderPublishBar() {
    const current = state.db.snapshots[state.db.currentSnapshotId];
    $('current-snap').textContent = current
        ? `当前快照：${current.id}（rev ${current.sourceRev}，${current.createdAt}）`
        : '当前快照：未发布（公开页将返回 404）';
    $('policy-gran').value = state.db.policy.publicGranularity;
}

function renderEventForm() {
    const sel = document.querySelector('#form-event [name=orgId]');
    sel.innerHTML = '<option value="">选择机构（多次活动共用机构地点）…</option>' +
        state.db.orgs.map((o) => `<option value="${o.id}">${o.currentName}</option>`).join('');
}

function renderPhotoEvents() {
    const sel = document.querySelector('#form-photo [name=eventId]');
    sel.innerHTML = state.db.events
        .slice().sort((a, b) => b.date.localeCompare(a.date))
        .map((e) => `<option value="${e.id}">${e.date} · ${e.title}</option>`).join('');
}

function fmtAuth(org, loc) {
    const today = state.helpers.today;
    const auths = (loc.authorizations || []);
    if (!auths.length) return '<span class="pill no">未授权公开</span>';
    return auths.map((a) => {
        const active = a.validFrom <= today && (a.validUntil === null || a.validUntil >= today);
        return `<span class="pill ${active ? 'ok' : 'rev'}">${active ? '授权中' : '已失效/撤销'} ${a.validFrom}~${a.validUntil || '长期'}</span>`;
    }).join(' ');
}

function renderOrgs() {
    const box = $('org-list');
    box.innerHTML = '';
    for (const o of state.db.orgs) {
        const div = document.createElement('div');
        div.className = 'org-item';
        const locs = (o.locations || []).slice().sort((a, b) => a.validFrom.localeCompare(b.validFrom));
        div.innerHTML = `
            <h4>${o.currentName} <code style="font-size:.7rem;color:#64748b">${o.id}</code></h4>
            <div class="org-meta">
                <span>名称时间线：${o.names.map((n) => `${n.validFrom}→${n.name}`).join(' ｜ ')}</span>
                ${locs.map((l) => `
                    <span>地点 ${l.validFrom} 起 · ${l.cityCode} · 私有精确点(已存储,不显示) · ${fmtAuth(o, l)}</span>`).join('')}
            </div>
            <div class="org-actions">
                <form data-act="rename">
                    <input type="date" name="validFrom" title="更名生效日" required>
                    <input name="name" placeholder="新名称" required>
                    <button class="btn btn-outline sm">更名（按有效期）</button>
                </form>
                <form data-act="relocate">
                    <input type="date" name="validFrom" title="搬迁生效日" required>
                    <select name="cityCode">${state.db.cities.map((c) => `<option value="${c.code}">${c.name}</option>`).join('')}</select>
                    <select name="coordSystem" title="坐標系">
                        <option value="wgs84">WGS84</option><option value="gcj02">GCJ-02</option>
                    </select>
                    <input name="rawLng" type="number" step="any" placeholder="经度" required>
                    <input name="rawLat" type="number" step="any" placeholder="纬度" required>
                    <button class="btn btn-outline sm">搬迁新址</button>
                </form>
                <form data-act="authorize">
                    <input type="date" name="validFrom" title="授权开始" required>
                    <input type="date" name="validUntil" title="留空=长期">
                    <input name="publicName" placeholder="机构授权公开名" required>
                    <input name="plng" type="number" step="any" placeholder="公开点经度" required>
                    <input name="plat" type="number" step="any" placeholder="公开点纬度" required>
                    <button class="btn btn-outline sm">授予公开</button>
                </form>
                <form data-act="revoke">
                    <input type="date" name="validUntil" title="撤销生效日" value="${state.helpers.today}">
                    <button class="btn btn-outline sm danger">撤销授权</button>
                </form>
            </div>`;
        div.querySelectorAll('form').forEach((form) => {
            form.addEventListener('submit', async (e) => {
                e.preventDefault();
                const act = form.dataset.act;
                const fd = Object.fromEntries(new FormData(form).entries());
                try {
                    if (act === 'rename') await api(`/orgs/${o.id}/name`, { method: 'POST', body: fd });
                    if (act === 'relocate') {
                        await api(`/orgs/${o.id}/locations`, {
                            method: 'POST',
                            body: { ...fd, rawLng: Number(fd.rawLng), rawLat: Number(fd.rawLat) },
                        });
                    }
                    if (act === 'authorize') {
                        await api(`/orgs/${o.id}/authorizations`, {
                            method: 'POST',
                            body: {
                                validFrom: fd.validFrom,
                                validUntil: fd.validUntil || null,
                                publicName: fd.publicName,
                                publicPoint: [Number(fd.plng), Number(fd.plat)],
                            },
                        });
                    }
                    if (act === 'revoke') await api(`/orgs/${o.id}/revoke`, { method: 'POST', body: { validUntil: fd.validUntil } });
                    window.showToast?.(`${act} 完成；已发布快照可能已被吊销，请重新发布`, 'success');
                    await refresh();
                } catch (err) { window.showToast?.(err.message, 'error'); }
            });
        });
        box.appendChild(div);
    }
}

function renderStateTable() {
    const orgById = Object.fromEntries(state.db.orgs.map((o) => [o.id, o]));
    const rows = state.db.events.slice().sort((a, b) => b.date.localeCompare(a.date)).map((e) => `
        <tr>
            <td>${e.date}</td>
            <td>${e.title}</td>
            <td>${orgById[e.orgId]?.currentName || e.orgId}</td>
            <td>${e.hours}h</td>
            <td>${e.photoIds?.length || 0} 张</td>
            <td><button class="btn btn-outline sm danger" data-del="${e.id}">删除</button></td>
        </tr>`).join('');
    $('state-table').innerHTML = `<table>
        <thead><tr><th>日期</th><th>事件</th><th>机构</th><th>时数</th><th>照片</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table>`;
    $('state-table').querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
            if (!confirm('确认删除该事件？')) return;
            await api(`/events/${btn.dataset.del}`, { method: 'DELETE' });
            await refresh();
        });
    });
}

// ---------------- 事件绑定 ----------------
$('btn-login').addEventListener('click', async () => {
    token = $('token').value.trim();
    try {
        await api('/login', { method: 'POST' });
        sessionStorage.setItem('vmap_admin_token', token);
        $('login-card').hidden = true;
        $('admin-panel').hidden = false;
        await refresh();
    } catch (e) { window.showToast?.(e.message, 'error'); }
});

$('form-event').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const body = {
        orgId: fd.get('orgId'), date: fd.get('date'), hours: Number(fd.get('hours')),
        title: fd.get('title'), role: fd.get('role'), summary: fd.get('summary'),
        coordSystem: fd.get('coordSystem'),
        pinnedLng: fd.get('pinnedLng') === '' ? undefined : Number(fd.get('pinnedLng')),
        pinnedLat: fd.get('pinnedLat') === '' ? undefined : Number(fd.get('pinnedLat')),
    };
    try {
        await api('/events', { method: 'POST', body });
        e.target.reset();
        window.showToast?.('事件已保存（注意：地图公开需重新发布快照）', 'success');
        await refresh();
    } catch (err) { window.showToast?.(err.message, 'error'); }
});

$('form-org').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
        await api('/orgs', { method: 'POST', body: { name: fd.get('name'), validFrom: fd.get('validFrom') || undefined } });
        e.target.reset();
        await refresh();
        window.showToast?.('机构已创建，请在下方补录地点', 'success');
    } catch (err) { window.showToast?.(err.message, 'error'); }
});

$('form-photo').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const file = fd.get('file');
    if (!file) return;
    const dataBase64 = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
    });
    try {
        const r = await api('/photos', { method: 'POST', body: { eventId: fd.get('eventId'), dataBase64, filename: file.name } });
        window.showToast?.(`照片已发布，EXIF/GPS 已剥离（${r.photo.bytes} 字节）`, 'success');
    } catch (err) { window.showToast?.(err.message, 'error'); }
});

$('btn-audit').addEventListener('click', async () => {
    const r = await api('/photos/audit');
    $('audit-out').textContent = JSON.stringify(r, null, 2);
    if (r.filesWithMetadata.length) window.showToast?.('发现残留元数据的派生图！', 'error');
    else window.showToast?.('公开媒体全部干净', 'success');
});

$('btn-reprocess').addEventListener('click', async () => {
    const r = await api('/photos/reprocess');
    $('audit-out').textContent = JSON.stringify(r, null, 2);
    window.showToast?.('已从私有原图重新清洗全部派生图', 'success');
});

$('btn-policy').addEventListener('click', async () => {
    await api('/policy', { method: 'PUT', body: { publicGranularity: $('policy-gran').value } });
    await refresh();
    window.showToast?.('粒度已更新，旧快照已吊销，请重新发布', 'success');
});

$('btn-publish').addEventListener('click', async () => {
    const r = await api('/snapshots/publish', { method: 'POST', body: { note: '管理页发布' } });
    await refresh();
    window.showToast?.(`已发布快照 ${r.id}`, 'success');
});

$('btn-preview').addEventListener('click', async () => {
    const r = await api('/snapshots/preview');
    $('preview-out').textContent = JSON.stringify(r, null, 2);
});

// 自动登录
if (token) {
    api('/state').then(() => {
        $('login-card').hidden = true;
        $('admin-panel').hidden = false;
        renderAll();
    }).catch(() => {});
}

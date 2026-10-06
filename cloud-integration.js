// Bazal Studio Supabase cloud integration
// Connects the existing v4 interface to the Supabase project without changing its layout.

const BAZAL_SUPABASE_URL = window.BAZAL_SUPABASE_URL;
const BAZAL_SUPABASE_KEY = window.BAZAL_SUPABASE_KEY;
if (!BAZAL_SUPABASE_URL || !BAZAL_SUPABASE_KEY) { throw new Error('Cloud configuration missing'); }
const bazalCloud = window.supabase.createClient(BAZAL_SUPABASE_URL, BAZAL_SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

let cloudProfiles = [];
let cloudReady = false;
let cloudSaveTimer = null;
let realtimeChannel = null;
let applyingRemoteState = false;

function cloudToast(msg){
  try { toast(msg); } catch (_) { console.log(msg); }
}

function mapProfile(p){
  const perms = p?.permissions || {};
  return {
    id: p.id,
    name: p.full_name || p.email || 'User',
    username: p.email || '',
    email: p.email || '',
    mobile: p.phone || '',
    role: p.role || 'staff',
    active: p.active !== false,
    perms: {
      billing: !!perms.billing,
      quotations: !!perms.quotations,
      production: !!perms.production,
      inventory: !!(perms.inventory ?? perms.manage_stock),
      reports: !!perms.reports,
      editPrice: !!(perms.editPrice ?? perms.edit_price),
      delete: !!(perms.delete ?? perms.delete_records),
      settings: !!(perms.settings ?? perms.manage_staff)
    },
    createdAt: p.created_at || null,
    lastLogin: null
  };
}

async function fetchMyProfile(){
  const { data: sessionData } = await bazalCloud.auth.getSession();
  const authUser = sessionData?.session?.user;
  if (!authUser) return null;
  const { data, error } = await bazalCloud
    .from('profiles')
    .select('id,email,full_name,phone,role,active,permissions,created_at,updated_at')
    .eq('id', authUser.id)
    .single();
  if (error) throw error;
  return mapProfile(data);
}

async function loadAllProfiles(){
  if (!user || user.role !== 'admin') {
    cloudProfiles = user ? [user] : [];
    return cloudProfiles;
  }
  const { data, error } = await bazalCloud.functions.invoke('manage-staff', { body: { action: 'list' } });
  if (error) throw error;
  if (data?.error) throw new Error(data.error);
  cloudProfiles = (data?.users || []).map(mapProfile);
  return cloudProfiles;
}

// Override local user list with cloud profiles after login.
users = function(){
  if (cloudProfiles.length) return cloudProfiles;
  return [];
};

saveUsers = function(a){
  cloudProfiles = Array.isArray(a) ? a : cloudProfiles;
};

async function pullCloudState(){
  const { data, error } = await bazalCloud
    .from('app_state')
    .select('data,updated_at')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw error;
  const remote = data?.data;
  const hasRemote = remote && typeof remote === 'object' && Object.keys(remote).length > 0;
  if (hasRemote) {
    applyingRemoteState = true;
    state = Object.assign(fresh(), remote);
    try { normalizeState(); } catch (_) {}
    localStorage.setItem(KEY, JSON.stringify(state));
    applyingRemoteState = false;
  } else {
    await pushCloudState(true);
  }
}

async function pushCloudState(immediate=false){
  if (!cloudReady || !user || applyingRemoteState) return;
  const run = async () => {
    const { data: sess } = await bazalCloud.auth.getSession();
    const uid = sess?.session?.user?.id || null;
    const { error } = await bazalCloud.from('app_state').upsert({
      id: 1,
      data: state,
      updated_by: uid,
      updated_at: new Date().toISOString()
    }, { onConflict: 'id' });
    if (error) console.error('Cloud save failed', error);
  };
  if (immediate) return run();
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(run, 350);
}

// Keep v4's existing local save behavior, then mirror it to Supabase.
const originalLocalSave = save;
save = function(){
  originalLocalSave();
  pushCloudState(false);
};

function subscribeCloudState(){
  if (realtimeChannel) bazalCloud.removeChannel(realtimeChannel);
  realtimeChannel = bazalCloud.channel('bazal-app-state')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'app_state', filter: 'id=eq.1' }, payload => {
      const remote = payload?.new?.data;
      if (!remote || applyingRemoteState) return;
      applyingRemoteState = true;
      state = Object.assign(fresh(), remote);
      try { normalizeState(); } catch (_) {}
      localStorage.setItem(KEY, JSON.stringify(state));
      applyingRemoteState = false;
      if (!document.querySelector('#app')?.classList.contains('hidden')) render();
    })
    .subscribe();
}

async function openAppFromSession(){
  try {
    const profile = await fetchMyProfile();
    if (!profile) return false;
    if (profile.active === false) {
      await bazalCloud.auth.signOut();
      cloudToast('यह staff account inactive है');
      return false;
    }
    user = profile;
    cloudProfiles = [profile];
    cloudReady = true;
    await pullCloudState();
    try { await loadAllProfiles(); } catch (e) { console.warn(e); }
    $('#login').classList.add('hidden');
    $('#app').classList.remove('hidden');
    updateAccess();
    render();
    subscribeCloudState();
    return true;
  } catch (e) {
    console.error(e);
    cloudToast('Cloud login setup error: ' + (e.message || e));
    return false;
  }
}

// Cloud login replaces the v4 local-password login.
$('#loginBtn').onclick = async () => {
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  if (!email || !password) return cloudToast('Email और password डालें');
  $('#loginBtn').disabled = true;
  try {
    const { error } = await bazalCloud.auth.signInWithPassword({ email, password });
    if (error) throw error;
    const ok = await openAppFromSession();
    if (ok) cloudToast('Cloud login successful');
  } catch (e) {
    cloudToast(e.message || 'Login failed');
  } finally {
    $('#loginBtn').disabled = false;
  }
};

$('#createAdminBtn').onclick = async () => {
  const email = $('#loginEmail').value.trim();
  const password = $('#loginPassword').value;
  if (!email.includes('@') || password.length < 6) return cloudToast('Valid email और 6+ character password डालें');
  $('#createAdminBtn').disabled = true;
  try {
    const { data, error } = await bazalCloud.auth.signUp({
      email,
      password,
      options: { data: { full_name: 'Admin' } }
    });
    if (error) throw error;
    if (data?.session) {
      await openAppFromSession();
      cloudToast('First Admin created');
    } else {
      cloudToast('Admin created. Email confirmation link आए तो confirm करके Login करें.');
    }
  } catch (e) {
    cloudToast(e.message || 'Admin create failed');
  } finally {
    $('#createAdminBtn').disabled = false;
  }
};

$('#logoutBtn').onclick = async () => {
  try { await pushCloudState(true); } catch (_) {}
  try { await bazalCloud.auth.signOut(); } catch (_) {}
  user = null;
  cloudProfiles = [];
  cloudReady = false;
  if (realtimeChannel) bazalCloud.removeChannel(realtimeChannel);
  $('#app').classList.add('hidden');
  $('#login').classList.remove('hidden');
  firstSetup();
};

firstSetup = async function(){
  $('#createAdminBtn').style.display = 'block';
  $('#firstSetup').textContent = 'Cloud login enabled. पहली बार Admin नहीं बना है तो अपना email/password डालकर Create First Admin करें.';
};

// Cloud-backed Staff / Users management while keeping the same v4 UI.
staffModal = function(id){
  if (user?.role !== 'admin') return cloudToast('Admin only');
  const x = cloudProfiles.find(u => u.id === id) || {name:'',email:'',mobile:'',role:'staff',active:true,perms:{...STAFF_PERMS}};
  const p = {...STAFF_PERMS, ...(x.perms||{})};
  openModal(id?'Edit Staff':'Add Staff',`<div class="formgrid">
    <div><label>Name</label><input id="un" value="${esc(x.name||'')}"></div>
    <div><label>Email</label><input id="ue" type="email" value="${esc(x.email||'')}"></div>
    <div><label>Mobile</label><input id="um" value="${esc(x.mobile||'')}"></div>
    <div><label>Role</label><select id="ur"><option value="staff" ${x.role!=='admin'?'selected':''}>Staff</option><option value="admin" ${x.role==='admin'?'selected':''}>Admin</option></select></div>
    <div><label>Status</label><select id="ua"><option value="1" ${x.active!==false?'selected':''}>Active</option><option value="0" ${x.active===false?'selected':''}>Inactive</option></select></div>
    <div class="full"><label>${id?'New Password (blank = unchanged)':'Password'}</label><input id="up" type="password" placeholder="Minimum 6 characters"></div>
    <div class="full"><label>Permissions</label><div class="perm-grid">${[['billing','Billing'],['quotations','Quotations'],['production','Production'],['inventory','Inventory / Products'],['reports','Reports'],['editPrice','Change Pricing'],['delete','Delete Records'],['settings','Settings / Staff']].map(([k,n])=>`<label><input type="checkbox" data-perm="${k}" ${p[k]?'checked':''}> ${n}</label>`).join('')}</div></div>
    <div class="full"><button id="usave" class="primary">Save Staff</button></div>
  </div>`);
  $('#usave').onclick = async () => {
    const name=$('#un').value.trim(), email=$('#ue').value.trim(), password=$('#up').value;
    if(!name || !email.includes('@')) return cloudToast('Name और valid email डालें');
    if(!id && password.length<6) return cloudToast('Password कम से कम 6 characters');
    if(password && password.length<6) return cloudToast('Password कम से कम 6 characters');
    const permissions={}; $$('[data-perm]').forEach(c=>permissions[c.dataset.perm]=c.checked);
    const role=$('#ur').value;
    if(role==='admin') Object.assign(permissions, ALL_PERMS);
    $('#usave').disabled=true;
    try {
      const body={action:id?'update':'create', id, name, email, phone:$('#um').value.trim(), role, active:$('#ua').value==='1', permissions, password};
      const {data,error}=await bazalCloud.functions.invoke('manage-staff',{body});
      if(error) throw error; if(data?.error) throw new Error(data.error);
      await loadAllProfiles(); closeModal(); render(); cloudToast('Staff saved');
    } catch(e){ cloudToast(e.message||'Staff save failed'); }
    finally { if($('#usave')) $('#usave').disabled=false; }
  };
};

deleteStaff = async function(id){
  if(user?.role!=='admin') return cloudToast('Admin only');
  if(id===user.id) return cloudToast('अपना account delete नहीं कर सकते');
  if(!confirm('Delete this staff login?')) return;
  try {
    const {data,error}=await bazalCloud.functions.invoke('manage-staff',{body:{action:'delete',id}});
    if(error) throw error; if(data?.error) throw new Error(data.error);
    await loadAllProfiles(); render(); cloudToast('Staff deleted');
  } catch(e){ cloudToast(e.message||'Staff delete failed'); }
};

// Settings no longer asks the user for URL/key because this build is already connected.
const originalSettings = settings;
settings = function(){
  let html = originalSettings();
  html = html.replace(/<div class="card"><div class="section-head"><h3>Cloud[\s\S]*?<\/div><\/div>`?$/,'');
  return html + `<div class="card" style="margin-top:15px"><div class="section-head"><h3>Cloud Database</h3></div><p class="muted">Connected to Bazal Studio Supabase. Phone और PC पर authorized users के लिए same live data sync होगा.</p><div class="badge b-green">CONNECTED</div></div>`;
};

// Session restore on page load.
(async function bootCloud(){
  firstSetup();
  const { data } = await bazalCloud.auth.getSession();
  if (data?.session) await openAppFromSession();
})();
const columns = ['created_at','consultant_name','dataset_id','tumour_site','tumour_type','differentiation','pt_stage','pn_stage','pm_stage','nodes_examined','nodes_positive','crm_involved','crm_distance_mm','margin_longitudinal_involved','margin_distal_involved','lvi_present','pni_present','emvi_present','neoadjuvant_given','tumour_block'];
const editable = columns.filter((c)=>c!=='created_at');
let rows=[];let filtered=[];let sort={key:'created_at',dir:'desc'};let current=null;
const thead=document.querySelector('#tbl thead');const tbody=document.querySelector('#tbl tbody');

function val(r,k){return r[k]??''}
function sortRows(){filtered.sort((a,b)=>{const av=String(val(a,sort.key));const bv=String(val(b,sort.key));return sort.dir==='asc'?av.localeCompare(bv):bv.localeCompare(av);});}
function renderTable(){thead.innerHTML='<tr>'+columns.map(c=>`<th data-k="${c}">${c}${sort.key===c?(sort.dir==='asc'?' ▲':' ▼'):''}</th>`).join('')+'<th>action</th></tr>';sortRows();tbody.innerHTML=filtered.map((r,i)=>`<tr>${columns.map(c=>`<td>${val(r,c)}</td>`).join('')}<td><button data-i='${i}'>Edit</button></td></tr>`).join('');document.getElementById('count').textContent=`${filtered.length} rows`;}
function applyClientFilters(){const q=document.getElementById('q').value.trim().toLowerCase();filtered=rows.filter((r)=>!q||columns.some((c)=>String(val(r,c)).toLowerCase().includes(q)));renderTable();}

async function search(){const p=new URLSearchParams();['dataset','consultant','from','to'].forEach((k)=>{const v=document.getElementById(k).value.trim();if(v)p.set({dataset:'dataset_id',consultant:'consultant_name',from:'from_date',to:'to_date'}[k],v)});
const res=await fetch(`/.netlify/functions/audit-admin-search?${p.toString()}`);const data=await res.json();if(!res.ok||!data.ok){alert(data.error||'load failed');return;}rows=data.rows||[];applyClientFilters();}

function openEditor(row){current=row;document.getElementById('editor').style.display='block';const wrap=document.getElementById('editFields');wrap.innerHTML=editable.map((k)=>`<label style='display:flex;flex-direction:column;min-width:220px;flex:1'><span style='font-size:11px;color:#a8b3cf'>${k}</span><input data-k='${k}' value='${(row[k]??'').toString().replace(/'/g,"&#39;")}'></label>`).join('');}
async function saveEdit(){if(!current) return;const edited_by=document.getElementById('editedBy').value.trim();if(!edited_by){alert('edited_by required');return;}const patch={};document.querySelectorAll('#editFields input').forEach((el)=>{const k=el.dataset.k;patch[k]=el.value===''?null:el.value;});
const res=await fetch('/.netlify/functions/audit-admin-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:current.id,edited_by,edit_reason:document.getElementById('editReason').value.trim(),patch})});
const data=await res.json();if(!res.ok||!data.ok){alert(data.error||'save failed');return;}document.getElementById('editor').style.display='none';search();}

async function loadOptions(){const r=await fetch('/.netlify/functions/audit-filter-options');const d=await r.json();if(!r.ok||!d.ok)return;const ds=document.getElementById('dataset');const cs=document.getElementById('consultant');ds.innerHTML="<option value=''>All specimen types</option>"+(d.specimen_types||[]).map(o=>`<option value='${o.dataset_id}'>${o.label}</option>`).join('');cs.innerHTML="<option value=''>All consultants</option>"+(d.consultants||[]).map(c=>`<option value='${c}'>${c}</option>`).join('');}
async function loadConsultantDirectory(){const r=await fetch('/.netlify/functions/audit-consultant-directory');const d=await r.json();if(!r.ok||!d.ok)return;const el=document.getElementById('consultantList');el.innerHTML=(d.consultants||[]).map(c=>`<span style='display:inline-flex;align-items:center;gap:6px;margin:4px;padding:4px 8px;border:1px solid rgba(255,255,255,.2);border-radius:999px;'>${c.name}<button data-del='${c.name}'>x</button></span>`).join('')||'No consultants yet. Add one to start using consistent names.';}
async function addConsultant(){const name=document.getElementById('newConsultant').value.trim();if(!name) return;const r=await fetch('/.netlify/functions/audit-consultant-directory',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});const d=await r.json();if(!r.ok||!d.ok){alert(d.error||'add failed');return;}document.getElementById('newConsultant').value='';await loadConsultantDirectory();await loadOptions();}
async function deleteConsultant(name){const r=await fetch('/.netlify/functions/audit-consultant-directory',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});const d=await r.json();if(!r.ok||!d.ok){alert(d.error||'delete failed');return;}await loadConsultantDirectory();await loadOptions();}

thead.addEventListener('click',(e)=>{const th=e.target.closest('th[data-k]');if(!th)return;const k=th.dataset.k;sort=k===sort.key?{key:k,dir:sort.dir==='asc'?'desc':'asc'}:{key:k,dir:'asc'};renderTable();});
tbody.addEventListener('click',(e)=>{const btn=e.target.closest('button[data-i]');if(!btn)return;openEditor(filtered[Number(btn.dataset.i)]);});
document.getElementById('search').addEventListener('click',search);document.getElementById('q').addEventListener('input',applyClientFilters);document.getElementById('reset').addEventListener('click',()=>{['q','dataset','consultant','from','to'].forEach((id)=>document.getElementById(id).value='');search();});
document.getElementById('saveEdit').addEventListener('click',saveEdit);document.getElementById('cancelEdit').addEventListener('click',()=>document.getElementById('editor').style.display='none');
document.getElementById('addConsultant').addEventListener('click',addConsultant);
document.getElementById('consultantList').addEventListener('click',(e)=>{const b=e.target.closest('button[data-del]');if(!b)return;deleteConsultant(b.dataset.del);});
Promise.all([loadOptions(),loadConsultantDirectory()]).then(search);

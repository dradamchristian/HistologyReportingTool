const tbody = document.querySelector('#tbl tbody');
let rows = [];

async function search(){
  const p = new URLSearchParams();
  ['dataset','consultant','from','to'].forEach((k)=>{ const v=document.getElementById(k).value.trim(); if(v)p.set({dataset:'dataset_id',consultant:'consultant_name',from:'from_date',to:'to_date'}[k],v);});
  const res = await fetch(`/.netlify/functions/audit-admin-search?${p.toString()}`);
  const data = await res.json();
  rows = data.rows || [];
  tbody.innerHTML = rows.map((r,i)=>`<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${r.consultant_name||''}</td><td>${r.dataset_id||''}</td><td>${r.tumour_site||''}</td><td>${r.pt_stage||''}</td><td>${r.nodes_positive??''}/${r.nodes_examined??''}</td><td>${r.crm_involved===null?'':(r.crm_involved?'Yes':'No')}</td><td><button data-i='${i}'>Edit</button></td></tr>`).join('');
}

tbody.addEventListener('click', async (e)=>{
  const btn = e.target.closest('button[data-i]'); if(!btn) return;
  const r = rows[Number(btn.dataset.i)];
  const tumour_site = prompt('tumour_site', r.tumour_site || ''); if (tumour_site === null) return;
  const consultant_name = prompt('consultant_name', r.consultant_name || ''); if (consultant_name === null) return;
  const edited_by = prompt('Edited by'); if (!edited_by) return alert('edited_by required');
  const res = await fetch('/.netlify/functions/audit-admin-update',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:r.id,edited_by,edit_reason:'Admin UI edit',patch:{tumour_site,consultant_name}})});
  const data = await res.json();
  if(!res.ok||!data.ok) return alert(data.error||'Update failed');
  alert('Updated');
  search();
});
document.getElementById('search').addEventListener('click', search);
search();

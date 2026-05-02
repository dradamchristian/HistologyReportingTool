async function load(){
  const p = new URLSearchParams();
  ['dataset','consultant','from','to'].forEach((k)=>{ const v=document.getElementById(k).value.trim(); if(v)p.set({dataset:'dataset_id',consultant:'consultant_name',from:'from_date',to:'to_date'}[k],v);});
  const res = await fetch(`/.netlify/functions/audit-dashboard?${p.toString()}`);
  const data = await res.json();
  if(!res.ok||!data.ok){ document.getElementById('totals').textContent=data.error||'Error'; return; }
  const total = data.totals?.total_cases || 0;
  const crmPos = data.totals?.crm_positive || 0;
  document.getElementById('totals').textContent = `Total cases: ${total}\nCRM positive: ${crmPos}\nCRM positivity rate: ${total?((crmPos/total)*100).toFixed(1):0}%`;
  document.getElementById('byDataset').textContent = JSON.stringify(data.by_dataset,null,2);
  document.getElementById('byConsultant').textContent = JSON.stringify(data.by_consultant,null,2);
}
document.getElementById('load').addEventListener('click', load);
load();

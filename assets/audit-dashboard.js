let last = null;
const el=(id)=>document.getElementById(id);
function daysAgo(n){const d=new Date();d.setDate(d.getDate()-n);return d.toISOString().slice(0,10)}
function bars(target,rows,label,valKey){const max=Math.max(1,...rows.map(r=>Number(r[valKey])||0));el(target).innerHTML=rows.map(r=>`<div style='margin:8px 0'><div style='display:flex;justify-content:space-between'><strong>${r[label]}</strong><span>${r[valKey]??0}</span></div><div class='bar'><div class='fill' style='width:${((Number(r[valKey])||0)/max)*100}%'></div></div></div>`).join('');}
function drawLine(rows){const svg=el('line');if(!rows.length){svg.innerHTML='';return;}const w=540,h=220,p=30;const vals=rows.flatMap(r=>[Number(r.mean_nodes)||0,Number(r.median_nodes)||0]);const min=Math.min(...vals)-1,max=Math.max(...vals)+1;const pt=(i,v)=>`${p+(i/Math.max(1,rows.length-1))*(w-p*2)},${h-p-((v-min)/(max-min||1))*(h-p*2)}`;const mean=rows.map((r,i)=>pt(i,Number(r.mean_nodes)||0)).join(' ');const med=rows.map((r,i)=>pt(i,Number(r.median_nodes)||0)).join(' ');
svg.innerHTML=`<line x1='${p}' y1='${h-p}' x2='${w-p}' y2='${h-p}' stroke='#b8c5d8'/><line x1='${p}' y1='${p}' x2='${p}' y2='${h-p}' stroke='#b8c5d8'/><polyline points='${mean}' fill='none' stroke='#0d1a39' stroke-width='4'/><polyline points='${med}' fill='none' stroke='#70839f' stroke-width='4' stroke-dasharray='10 8'/>`+rows.map((r,i)=>`<text x='${p+(i/Math.max(1,rows.length-1))*(w-p*2)}' y='${h-8}' text-anchor='middle' fill='#506a8a' font-size='12'>${r.month_label}</text>`).join('');}

function pct(n,d){return d?Math.round((Number(n)||0)*100/d):0;}
function invStatus(v){return v===true?'Present':(v===false?'Absent':'Unknown');}

function benchmarkCard({label,numerator,denominator,target,comparator='gte'}){const pctValue=pct(numerator,denominator);const hit=comparator==='lte'?pctValue<=target:pctValue>=target;const status=hit?'On target':'Below target';const statusClass=hit?'ok':'warn';const targetText=`${comparator==='lte'?'≤':'≥'} ${target}%`;return `<div class='benchmark-card'><div class='benchmark-head'><div class='benchmark-label'>${label}</div><span class='benchmark-status ${statusClass}'>${status}</span></div><div class='benchmark-value'>${pctValue}%</div><div class='benchmark-meta'>${numerator}/${denominator||0} cases · Target ${targetText}</div></div>`;}
function render(d){last=d;const t=d.totals||{};const u=d.usage_stats||{};const total=Number(t.case_count)||0,r1=Number(t.r1_cases)||0,lvi=Number(t.lvi_cases)||0,pni=Number(t.pni_cases)||0,emvi=Number(t.emvi_cases)||0,distal=Number(t.distal_margin_involved_cases)||0,prox=Number(t.proximal_margin_involved_cases)||0,pt3=Number(t.pt3_or_higher_cases)||0,ge12=Number(t.ge12_cases)||0;
 el('metrics').innerHTML=`
  <div class='card metric soft'><div class='muted'>Total cases</div><div class='v'>${total}</div></div>
  <div class='card metric soft'><div class='muted'>Node yield ≥12</div><div class='v'>${pct(ge12,total)}%</div><div class='tiny'>${ge12}/${total||0}</div></div>
  <div class='card metric soft'><div class='muted'>R1/any margin involved</div><div class='v'>${pct(r1,total)}%</div><div class='tiny'>${r1}/${total||0}</div></div>
  <div class='card metric soft'><div class='muted'>pT3/pT4 rate</div><div class='v'>${pct(pt3,total)}%</div><div class='tiny'>${pt3}/${total||0}</div></div>
  <div class='card metric soft'><div class='muted'>Lymphatic invasion present</div><div class='v'>${pct(lvi,total)}%</div><div class='tiny'>${lvi}/${total||0}</div></div>
  <div class='card metric soft'><div class='muted'>Venous invasion present</div><div class='v'>${pct(emvi,total)}%</div><div class='tiny'>${emvi}/${total||0}</div></div>`;

 const benchmarkCards=[
  {label:'Nodes ≥12 retrieval rate',numerator:ge12,denominator:total,target:85,comparator:'gte'},
  {label:'Venous invasion detection rate',numerator:emvi,denominator:total,target:30,comparator:'gte'},
  {label:'CRM involved rate',numerator:r1,denominator:total,target:10,comparator:'lte'},
  {label:'pT3/pT4 case-mix',numerator:pt3,denominator:total,target:50,comparator:'gte'}
 ];
 el('qualityBenchmarks').innerHTML=benchmarkCards.map(benchmarkCard).join('');

 bars('siteBars',d.by_site||[],'site','cases');bars('meanBars',d.by_consultant||[],'consultant_name','mean_nodes');bars('caseBars',d.by_consultant||[],'consultant_name','cases');drawLine(d.monthly||[]);
 const risk=[['R1 / involved margin',r1],['Lymphatic invasion present',lvi],['PNI present',pni],['Venous invasion present',emvi],['Proximal margin involved',prox],['Distal margin involved',distal]];
 bars('riskBars',risk.map(([label,cases])=>({label,cases})), 'label', 'cases');
 el('capturedSummary').innerHTML=[
  ['Cases analysed',total,'base cohort'],['Nodes ≥12',ge12,`${pct(ge12,total)}%`],['R1 / involved',r1,`${pct(r1,total)}%`],['pT3 or higher',pt3,`${pct(pt3,total)}%`],['Lymphatic invasion present',lvi,`${pct(lvi,total)}%`],['PNI present',pni,`${pct(pni,total)}%`],['Venous invasion present',emvi,`${pct(emvi,total)}%`],['Prox margin involved',prox,`${pct(prox,total)}%`],['Distal margin involved',distal,`${pct(distal,total)}%`]
 ].concat((()=>{const sb=d.stage_breakdown||{};return [
['T1/T2/T3/T4',`${sb.t1_cases||0}/${sb.t2_cases||0}/${sb.t3_cases||0}/${sb.t4_cases||0}`,'T stage distribution'],
['N0/N1/N2',`${sb.n0_cases||0}/${sb.n1_cases||0}/${sb.n2_cases||0}`,'N stage distribution'],
['M0/M1',`${sb.m0_cases||0}/${sb.m1_cases||0}`,'M stage distribution']
];})()).map(([k,v,meta])=>`<div class='pill'><div class='tiny'>${k}</div><div style='font-size:28px;font-weight:800'>${v}</div><div class='mini muted'>${meta}</div></div>`).join('');

 const bRows=(d.benchmark||[]);
 el('benchmarkTable').querySelector('tbody').innerHTML=bRows.map(r=>{const total=Number(r.total_generations)||0;const errors=Number(r.error_count)||0;const errPct=total?((errors*100)/total).toFixed(2):'0.00';const inTok=r.avg_input_tokens==null?'-':Number(r.avg_input_tokens).toFixed(1);const outTok=r.avg_output_tokens==null?'-':Number(r.avg_output_tokens).toFixed(1);const avgCost=r.avg_estimated_cost_usd==null?'-':Number(r.avg_estimated_cost_usd).toFixed(6);return `<tr><td>${r.model||'Unknown'}</td><td>${total}</td><td>${r.avg_duration_ms??'-'}</td><td>${avgCost}</td><td>${errPct}%</td><td>${inTok} / ${outTok}</td></tr>`;}).join('');
 el('cases').querySelector('tbody').innerHTML=(d.cases||[]).map(r=>`<tr class='${(r.nodes_examined!==null&&Number(r.nodes_examined)<12)||r.crm_involved?'flag':''}'><td>${r.case_date||''}</td><td>${r.consultant_name||''}</td><td>${r.tumour_site||''}</td><td>${[r.pt_stage,r.pn_stage,r.pm_stage].filter(Boolean).join(' ')}</td><td>${r.nodes_positive??''}/${r.nodes_examined??''}</td><td>${r.crm_involved?'R1':'R0'}${r.crm_distance_mm?` - CRM ${r.crm_distance_mm}mm`:''}${r.margin_longitudinal_involved?' / Prox involved':''}${r.margin_distal_involved?' / Distal involved':''}</td><td>Lymphatic: ${invStatus(r.lvi_present)} (${r.lymphatic_invasion_level||'n/a'}) / Perineural: ${invStatus(r.pni_present)} (${r.perineural_invasion_level||'n/a'}) / Venous: ${invStatus(r.emvi_present)} (${r.venous_invasion_level||'n/a'})</td></tr>`).join('');
 const notice=el('usageNotice');if(notice){notice.textContent=d.usage_metrics_configured===false?(d.usage_metrics_notice||'Usage/cost metrics not configured yet'):'';}
}
async function load(){const p=new URLSearchParams();if(el('consultant').value)p.set('consultant_name',el('consultant').value);if(el('specimen').value)p.set('dataset_id',el('specimen').value);if(el('q').value)p.set('site_query',el('q').value);if(el('window').value!=='all')p.set('from_date',daysAgo(Number(el('window').value)));if(el('modelFilter').value)p.set('model',el('modelFilter').value);const res=await fetch(`/.netlify/functions/audit-dashboard?${p.toString()}`);const d=await res.json();if(!res.ok||!d.ok){console.error('Audit dashboard load failed',d.error||'failed');const notice=el('usageNotice');if(notice)notice.textContent='Unable to refresh dashboard right now.';return;}render(d)}
function exportCsv(){if(!last?.usage_rows?.length)return;const h=['created_at','dataset','requested_mode','actual_model','duration_ms','input_tokens','output_tokens','total_tokens','estimated_cost_usd','success','error_message','deploy_context'];const lines=[h.join(',')].concat(last.usage_rows.map(r=>h.map(k=>`"${(r[k]??'').toString().replaceAll('"','""')}"`).join(',')));const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([lines.join('\n')],{type:'text/csv'}));a.download='generation-usage.csv';a.click();}
['q','consultant','specimen','window','modelFilter'].forEach(id=>el(id).addEventListener(id==='q'?'input':'change',load));async function loadOptions(){const r=await fetch('/.netlify/functions/audit-filter-options');const d=await r.json();if(!r.ok||!d.ok)return;el('consultant').innerHTML="<option value=''>All consultants</option>"+(d.consultants||[]).map(c=>`<option value='${c}'>${c}</option>`).join('');el('specimen').innerHTML="<option value=''>All specimen types</option>"+(d.specimen_types||[]).map(o=>`<option value='${o.dataset_id}'>${o.label}</option>`).join('');}

el('load').addEventListener('click',load);el('csv').addEventListener('click',exportCsv);loadOptions().then(load);

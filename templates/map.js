'use strict';
const byId = id => document.getElementById(id);
const archive = JSON.parse(byId('dataset').textContent);
const geography = JSON.parse(byId('basemap').textContent);
const roads = archive.roads;
const surface = byId('surface');
const canvas = byId('canvas');
const ctx = canvas.getContext('2d');
const latitudeFactor = 1 / Math.cos(31.2 * Math.PI / 180);
const metresPerUnit = 1.1132 / latitudeFactor;
const project = ([lon,lat]) => [(lon-121)*100000, -(lat-31)*100000*latitudeFactor];
const pointFromPair = (x,y) => [x,-y*latitudeFactor];
const cityCenter = project([121.466,31.219]);
const bounds = geography.bounds;
const mapBounds = [project([bounds[0],bounds[3]]), project([bounds[2],bounds[1]])];
const view = {center:cityCenter.slice(),scale:0.08,width:1,height:1,mode:'city'};
let visible = roads.map((_,index)=>index), selected = null, frame = 0, priorView = null;
const minimumScale = 0.006, maximumScale = 1.55;
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(id, cls='ic') {
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns,'svg');
  const use = document.createElementNS(ns,'use');
  svg.setAttribute('class',cls); svg.setAttribute('aria-hidden','true');
  use.setAttribute('href','#'+id); svg.append(use); return svg;
}
function boundsOf(points) {
  const box = [Infinity,Infinity,-Infinity,-Infinity];
  for (const [x,y] of points) {
    box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);
    box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
  }
  return box;
}
function screen([x,y]) {return [(x-view.center[0])*view.scale+view.width/2,(y-view.center[1])*view.scale+view.height/2];}
function world([x,y]) {return [(x-view.width/2)/view.scale+view.center[0],(y-view.height/2)/view.scale+view.center[1]];}
function queueDraw() {if (!frame) frame=requestAnimationFrame(draw);}
function limitView() {
  view.scale=Math.max(minimumScale,Math.min(maximumScale,view.scale));
  for (let i=0;i<2;i++) view.center[i]=Math.min(mapBounds[1][i],Math.max(mapBounds[0][i],view.center[i]));
}
function camera(center,scale,mode) {
  view.center=center; view.scale=scale; view.mode=mode;
  limitView(); queueDraw();
}
function fitPoints(points,mode,cap=.72) {
  if (!points.length) {camera(cityCenter.slice(),cityScale(),mode); return;}
  const [x0,y0,x1,y1]=boundsOf(points);
  const padX=Math.min(110,view.width*.19), padY=Math.min(96,view.height*.23);
  const scale=Math.min((view.width-2*padX)/Math.max(x1-x0,1),(view.height-2*padY)/Math.max(y1-y0,1),cap);
  camera([(x0+x1)/2,(y0+y1)/2],scale,mode);
}
function cityScale() {return Math.min(view.width/11350,view.height/5100);}
function cityView(){camera(cityCenter.slice(),cityScale(),'city');}
const position = roads.map(road => {
  const loc=road.location;
  if (!loc || !loc.point) return null;
  return {point:project(loc.point), paths:(loc.paths||[]).map(line=>line.map(project))};
});
function fitRoads() {
  const points=visible.flatMap(i=>position[i]?[position[i].point,...position[i].paths.flat()]:[]);
  fitPoints(points,'all',visible.length===1?.42:.22);
}
function frameSelection(i) {
  const pos=position[i];
  if(!pos) return;
  const kind=roads[i].location.kind;
  fitPoints(pos.paths.length?pos.paths.flat():[pos.point],'selected',kind==='area'?.105:kind==='point'?.48:.72);
}
function zoomAt(factor,x=view.width/2,y=view.height/2) {
  const before=world([x,y]);
  const scale=Math.min(maximumScale,Math.max(minimumScale,view.scale*factor));
  camera([before[0]-(x-view.width/2)/scale,before[1]-(y-view.height/2)/scale],scale,'free');
}
// Geographic elements share one WGS84 local projection. Both positions and road vertices use this transform.
const features = geography.features.map(([kind,name,parts])=>{
  const path=new Path2D(), box=[Infinity,Infinity,-Infinity,-Infinity];
  let anchor=null, length=0;
  for (const flat of parts) {
    for(let i=0;i<flat.length;i+=2){
      const [x,y]=pointFromPair(flat[i],flat[i+1]);
      if(i===0) path.moveTo(x,y);else path.lineTo(x,y);
      box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);
      box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
      if(i>=2) length+=Math.hypot(x-flat[i-2],y+flat[i-1]*latitudeFactor);
    }
    if(!anchor && flat.length>=4) {
      const mid=2*Math.floor((flat.length/2-1)/2);
      anchor=pointFromPair((flat[mid]+flat[mid+2])/2,(flat[mid+1]+flat[mid+3])/2);
    }
  }
  return {kind,name,path,box,anchor,length};
});
const grouped = new Map();
for (const feature of features) {
  if(!grouped.has(feature.kind)) grouped.set(feature.kind,[]);
  grouped.get(feature.kind).push(feature);
}
const placeLabels=geography.places.map(([name,kind,x,y])=>({name,kind,point:pointFromPair(x,y)}));
const mapPalette = {
  field:'#e4e8d1',block:'#e6e1d3',green:'#d0dfba',building:'#d8d0bf',water:'#a9cfcd',
  river:'#9bc4c2',canal:'#b0cfcc',rail:'#b7b2a9',lane:'#fffdf5',street:'#fffdf5',
  secondary:'#fffef4',main:'#fffae5',highway:'#ead5a5'
};
const polygonLayers=['field','block','green','building','water'];
const roadLayers=['lane','street','secondary','main','highway'];
const cutoffs={field:0,block:.041,green:0,building:.28,water:0,river:0,canal:.052,rail:.03,lane:.067,street:.046,secondary:.019,main:0,highway:0};
const widths={river:1.7,canal:1,rail:1.1,lane:1.5,street:2.2,secondary:2.9,main:3.8,highway:3.6};
const labelRoads=['river','green','main','secondary','street','lane','highway'];
const lineOrder=['river','canal','rail',...roadLayers];
function inWindow(box,window) {return box[0]<=window[2] && box[2]>=window[0] && box[1]<=window[3] && box[3]>=window[1];}
function draw() {
  frame=0;
  const {width,height,scale}=view,dpr=canvas.width/Math.max(1,width);
  const [left,top]=world([0,0]), [right,bottom]=world([width,height]);
  const window=[left,top,right,bottom];
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#eeecdf';ctx.fillRect(0,0,width,height);
  ctx.setTransform(dpr*scale,0,0,dpr*scale,-left*scale*dpr,-top*scale*dpr);
  ctx.lineJoin='round';ctx.lineCap='round';
  const shown={};
  for(const kind of [...polygonLayers,...lineOrder]){
    const layer=scale>=cutoffs[kind]?(grouped.get(kind)||[]):[];
    shown[kind]=layer.filter(f=>inWindow(f.box,window));
  }
  for(const kind of polygonLayers) {
    ctx.fillStyle=mapPalette[kind];
    for(const f of shown[kind]) ctx.fill(f.path,'evenodd');
  }
  const widthRatio=Math.max(.65,Math.min(1.9,(scale/.105)**.32));
  for(const kind of lineOrder) {
    const path=new Path2D();
    for(const f of shown[kind]) path.addPath(f.path);
    if(roadLayers.includes(kind) && scale>.03) {
      ctx.strokeStyle=kind==='highway'?'#c5b480':'#d0cbbc';
      ctx.lineWidth=(widths[kind]*widthRatio+1.05)/scale;ctx.stroke(path);
    }
    ctx.strokeStyle=mapPalette[kind];ctx.lineWidth=widths[kind]*widthRatio/scale;
    ctx.setLineDash(kind==='rail'?[3/scale,3/scale]:[]);ctx.stroke(path);
    ctx.setLineDash([]);
  }
  // Draw the selected road last so that overlapping roads never cover it.
  const order=visible.filter(i=>i!==selected);
  if(selected!==null) order.push(selected);
  for(const i of order) {
    const pos=position[i];if(!pos)continue;
    const active=i===selected;
    for(const points of pos.paths){
      ctx.beginPath();
      points.forEach(([x,y],j)=>j?ctx.lineTo(x,y):ctx.moveTo(x,y));
      ctx.strokeStyle='#fffbed';ctx.lineWidth=(active?7.4:4.2)/scale;ctx.stroke();
      ctx.strokeStyle=active?'#a34832':roads[i].credibility==='待考'?'#99652e':'#387361';
      ctx.lineWidth=(active?4.3:2.2)/scale;ctx.stroke();
    }
  }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const collisions=positionMarkers();
  function textLabel(name,point,size,color,strong=false){
    const [x,y]=screen(point);if(x<18||x>width-18||y<16||y>height-18)return false;
    ctx.font=(strong?'650 ':'450 ')+size+'px "PingFang SC","Microsoft YaHei",sans-serif';
    const half=ctx.measureText(name).width/2, box=[x-half-5,y-size*.7-4,x+half+5,y+size*.7+4];
    if(collisions.some(b=>inWindow(b,box)))return false;
    collisions.push(box);ctx.textAlign='center';ctx.textBaseline='middle';
    ctx.strokeStyle='#f8f6e8e0';ctx.lineWidth=3.2;ctx.strokeText(name,x,y);
    ctx.fillStyle=color;ctx.fillText(name,x,y);return true;
  }
  const used=new Set();
  for(const p of placeLabels){
    if(!p.name || used.has(p.name))continue;
    const isDistrict=p.kind==='city'||p.name.endsWith('区')&&p.kind==='suburb';
    if(isDistrict && scale>.22 || p.kind==='landmark' && scale<.04 || !isDistrict && p.kind!=='landmark' && scale<(p.kind==='town'?.017:.095))continue;
    if(textLabel(p.name,p.point,isDistrict?16:p.kind==='landmark'?13:12,isDistrict?'#657568':'#68766a',isDistrict)) used.add(p.name);
  }
  for(const kind of labelRoads){
    if(!['river','green'].includes(kind) && scale<(kind==='main'?.057:kind==='secondary'?.09:.17))continue;
    for(const f of shown[kind]){
      if(!f.name||used.has(f.name)||!f.anchor||f.name.length>13 || kind!=='green'&&f.length*scale<65)continue;
      if(textLabel(f.name,f.anchor,kind==='river'?14:12,kind==='river'?'#497d7b':kind==='green'?'#647b54':'#77776b',kind==='river'))used.add(f.name);
    }
  }
  const distances=[10,20,50,100,200,500,1000,2000,5000,10000,20000];
  const target=82*metresPerUnit/scale;
  const distance=distances.filter(d=>d<=target).pop()||10;
  byId('scale-text').textContent=distance>=1000?(distance/1000)+' km':distance+' m';
  byId('scale-bar').style.width=(distance/metresPerUnit*scale)+'px';
  byId('city').setAttribute('aria-pressed',view.mode==='city');
  byId('fit').setAttribute('aria-pressed',view.mode==='all');
  byId('zoom-in').disabled=scale>=maximumScale;byId('zoom-out').disabled=scale<=minimumScale;
}
const statusClass={'已查证':'','待考':' pending','传说':' legend'};
const markerNodes=roads.map((r,i)=>{
  if(!position[i])return null;
  const button=el('button','mark'+statusClass[r.credibility],String(i+1));
  button.setAttribute('aria-label','定位'+r.name+'（'+r.district+'）');button.type='button';
  const kind=r.location.kind;button.classList.add(kind);
  const label=el('span','mapname',r.name+(kind==='area'?' · 片区':kind==='point'?' · 路口':''));
  button.append(label);byId('marks').append(button);
  button.addEventListener('click',()=>selectRoad(i,'marker'));
  return {button,label};
});
function positionMarkers() {
  const taken=[], occupied=[];
  const priority=visible.filter(i=>i!==selected);
  if(selected!==null)priority.unshift(selected);
  for(let i=0;i<markerNodes.length;i++) if(markerNodes[i])markerNodes[i].button.hidden=true;
  const {width,height}=view;
  const blocked=[[4,3,156,51],[width-43,4,width-5,65],[width-61,height-147,width-3,height-28],[0,height-28,width,height]];
  for(const i of priority){
    const m=markerNodes[i];if(!m)continue;
    const [x,y]=screen(position[i].point);
    if(x<-10||x>width+10||y<-10||y>height+10)continue;
    let mx=x,my=y;
    const overlaps=(a,b)=>occupied.some(box=>inWindow(box,[a-13,b-13,a+13,b+13]));
    if(overlaps(mx,my)){
      search: for(const radius of [25,39,55,72]){
        for(const [dx,dy] of [[1,0],[-1,0],[0,-1],[0,1],[.72,-.72],[-.72,.72],[.72,.72],[-.72,-.72]]){
          const px=x+dx*radius,py=y+dy*radius;
          if(px<13||px>width-13||py<13||py>height-13||overlaps(px,py))continue;
          mx=px;my=py;break search;
        }
      }
      if(mx!==x||my!==y){
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(mx,my);ctx.strokeStyle='#637866';ctx.lineWidth=1.3;ctx.stroke();
        ctx.beginPath();ctx.arc(x,y,2.5,0,2*Math.PI);ctx.fillStyle='#365a47';ctx.fill();
      }
    }
    m.button.hidden=false;m.button.style.left=mx+'px';m.button.style.top=my+'px';
    m.button.classList.toggle('chosen',i===selected);m.button.setAttribute('aria-pressed',i===selected);
    occupied.push([mx-12,my-12,mx+12,my+12]);
  }
  for(const i of priority){
    const m=markerNodes[i];if(!m||m.button.hidden)continue;
    const x=parseFloat(m.button.style.left),y=parseFloat(m.button.style.top);
    const w=m.label.textContent.length*(width<550?13:14)+14;
    const choices=[[15,-13],[-w-15,-13],[-w/2,-39],[-w/2,16]];
    m.label.hidden=true;
    for(const [dx,dy] of choices){
      const box=[x+dx-1,y+dy-1,x+dx+w+1,y+dy+24];
      if(box[0]<0||box[2]>width||box[1]<0||box[3]>height||[...blocked,...taken,...occupied].some(b=>inWindow(b,box)))continue;
      m.label.style.left=(dx+10)+'px';m.label.style.top=(dy+10)+'px';m.label.hidden=false;
      taken.push(box);break;
    }
  }
  return [...blocked,...taken,...occupied];
}
function externalLink(title,url) {
  const link=el('a','',title);link.href=url;link.target='_blank';link.rel='noopener noreferrer';return link;
}
function field(parent,title,content,cls) {parent.append(el('h3','',title),el('p',cls,content));}
function citations(parent,sources) {
  const ul=el('ul','sources');
  for(const src of sources){
    const li=el('li');li.append(externalLink(src.title+' ↗',src.url));
    if(src.scope)li.append(el('span','source-scope',src.scope));ul.append(li);
  }
  parent.append(ul);
}
const locLabel={line:'道路走向',point:'路口参考点',area:'片区参考点'};
function renderStory(i) {
  const road=roads[i], loc=road.location, story=byId('story');story.replaceChildren();
  story.append(el('h2','road-title',road.name));
  const meta=el('div','badge-line');
  meta.append(el('span','',road.district),el('span','state'+statusClass[road.credibility],road.credibility));
  story.append(meta,el('p','loc',loc?locLabel[loc.kind]+' · '+loc.description:'位置待核，暂未标绘。'));
  if(loc) {
    const [lon,lat]=loc.point;
    const link=externalLink(loc.kind==='area'?'在原图看片区参考点 ↗':'在原图查看位置 ↗',
      'https://www.openstreetmap.org/?mlat='+lat+'&mlon='+lon+'#map=17/'+lat+'/'+lon);
    link.className='crosslink';story.append(link);
  }
  field(story,road.credibility==='传说'?'民间传说':'路名由来',road.story||'待考');
  if(road.fun_fact)field(story,'街头拾零',road.fun_fact);
  if(road.old_names.length)field(story,'旧名',road.old_names.join('、'));
  field(story,'归档',road.area_group+' · '+(road.naming_type.join('、')||'命名类型待考'));
  story.append(el('h3','','故事与地址出处'));citations(story,road.sources);
  if(loc){story.append(el('h3','','定位依据'));citations(story,loc.sources);}
  if(road.legend){const extra=el('section','legend-block');field(extra,'另录 · 民间传说',road.legend.text);citations(extra,road.legend.sources);story.append(extra);}
  if(road.notes)field(story,'收藏备注',road.notes,'annotation');
}
let returnSource='row', lastSelected=null;
function selectRoad(i,source) {
  if(!visible.includes(i))return;
  if(selected===null) priorView={center:view.center.slice(),scale:view.scale,mode:view.mode};
  selected=i;lastSelected=i;returnSource=source;
  byId('browse').hidden=true;byId('details').hidden=false;renderStory(i);byId('details').scrollTop=0;
  const loc=roads[i].location;
  byId('map-hint').hidden=!loc;
  byId('map-hint-name').textContent=roads[i].name;
  byId('map-hint-text').textContent=loc?locLabel[loc.kind]:'';
  byId('map-hint').className='map-hint '+(loc?.kind||'');
  byId('map-caption').hidden=!!loc;byId('map-caption').textContent=loc?'':'该路的位置还待核实。';
  frameSelection(i);queueDraw();
  byId('back').focus({preventScroll:true});
  if(matchMedia('(max-width:720px)').matches && source==='row') byId('map').scrollIntoView({block:'start'});
}
function returnToList(restore=true) {
  selected=null;byId('details').hidden=true;byId('browse').hidden=false;
  byId('map-hint').hidden=true;byId('map-caption').hidden=true;
  if(restore && priorView) camera(priorView.center.slice(),priorView.scale,priorView.mode);
  priorView=null;queueDraw();
}
byId('back').addEventListener('click',()=>{
  returnToList();
  const target=returnSource==='marker'?markerNodes[lastSelected]?.button:rows[lastSelected]?.button;
  (target&&!target.hidden?target:byId('query')).focus({preventScroll:true});
});
const rows=roads.map((r,i)=>{
  const li=el('li'),button=el('button','row');button.type='button';
  button.setAttribute('aria-label',r.name+'，'+r.district+'，'+r.credibility);
  const copy=el('span','row-copy'), heading=el('span','row-label');
  heading.append(el('span','row-name',r.name),el('span','state'+statusClass[r.credibility],r.credibility));
  const names=r.district+(r.location?.kind==='area'?' · 片区参考':r.location?.kind==='point'?' · 路口定位':'');
  copy.append(heading,el('span','row-place',names));
  button.append(el('span','index-number',String(i+1).padStart(2,'0')),copy,icon('down','ic go'));
  button.addEventListener('click',()=>selectRoad(i,'row'));li.append(button);byId('roads').append(li);
  return {li,button};
});
const norm=v=>v.normalize('NFKC').toLowerCase().replace(/\s+/gu,'');
const queryInput=byId('query'), area=byId('area'), type=byId('type'), state=byId('state');
function options(select,label,values){select.add(new Option(label,''));for(const v of values)select.add(new Option(v,v));}
options(area,'全部区域',archive.areas);options(type,'命名类型',archive.types);options(state,'可信度',archive.states);
function filter(reframe=true) {
  const term=norm(queryInput.value);visible=[];
  roads.forEach((r,i)=>{
    const match=[r.name,r.pinyin||'',...r.old_names].some(v=>norm(v).includes(term)) &&
      (!area.value||area.value===r.area_group)&&(!type.value||r.naming_type.includes(type.value))&&(!state.value||r.credibility===state.value);
    rows[i].li.hidden=!match;if(match)visible.push(i);
  });
  const active=!!(term||area.value||type.value||state.value);
  byId('count').textContent=active?visible.length+' / '+roads.length+' 条':'共 '+roads.length+' 条';
  byId('fit').textContent=active?'筛选结果':'全部道路';
  byId('empty').hidden=visible.length>0;byId('reset').hidden=!active;
  byId('map-caption').hidden=visible.length>0;
  if(!visible.length)byId('map-caption').textContent='当前筛选没有匹配的道路';
  for(const s of [area,type,state])s.parentElement.classList.toggle('active',!!s.value);
  if(reframe){if(active&&visible.length)fitRoads();else if(!active)cityView();}
  queueDraw();
}
queryInput.addEventListener('input',()=>filter());
for(const s of [area,type,state])s.addEventListener('change',()=>filter());
document.querySelector('.filters').addEventListener('submit',e=>e.preventDefault());
function clearAll(){document.querySelector('.filters').reset();filter();queryInput.focus({preventScroll:true});}
byId('reset').addEventListener('click',clearAll);byId('showall').addEventListener('click',clearAll);
byId('city').addEventListener('click',()=>{if(selected!==null)returnToList(false);cityView();});
byId('fit').addEventListener('click',()=>{if(selected!==null)returnToList(false);fitRoads();});
byId('zoom-in').addEventListener('click',()=>zoomAt(1.55));byId('zoom-out').addEventListener('click',()=>zoomAt(1/1.55));
byId('about').addEventListener('click',()=>byId('rules').showModal());
byId('close').addEventListener('click',()=>byId('rules').close());
byId('rules').addEventListener('click',e=>{
  const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)e.currentTarget.close();
});
byId('download-map').addEventListener('click',()=>{
  const locations=roads.filter(r=>r.location).map(r=>({name:r.name,district:r.district,location:r.location}));
  const url=URL.createObjectURL(new Blob([JSON.stringify({geography,locations})],{type:'application/json'}));
  const link=el('a');link.href=url;link.download='上海鹿鸣-地理数据.json';link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1500);
});
function pointerAt(e){const b=surface.getBoundingClientRect();return [e.clientX-b.left,e.clientY-b.top];}
const pointers=new Map();let start=null, moved=false;
function gesture(){
  const [a,b]=pointers.values();
  if(!a)return null;if(!b)return {x:a[0],y:a[1],span:0};
  return {x:(a[0]+b[0])/2,y:(a[1]+b[1])/2,span:Math.hypot(a[0]-b[0],a[1]-b[1])};
}
surface.addEventListener('pointerdown',e=>{
  if(e.target.closest('button')||e.button!==0)return;
  const p=pointerAt(e);if(!pointers.size){start=p;moved=false;}
  pointers.set(e.pointerId,p);if(pointers.size>1)moved=true;
  surface.setPointerCapture(e.pointerId);surface.classList.add('dragging');
});
surface.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId))return;
  const prev=gesture(),p=pointerAt(e);pointers.set(e.pointerId,p);
  const next=gesture();
  if(!moved&&start&&Math.hypot(p[0]-start[0],p[1]-start[1])<3)return;
  moved=true;
  if(prev.span>2 && next.span>2)zoomAt(next.span/prev.span,prev.x,prev.y);
  camera([view.center[0]-(next.x-prev.x)/view.scale,view.center[1]-(next.y-prev.y)/view.scale],view.scale,'free');
});
function nearestRoad(p){
  let best=10,found=null;
  for(const i of visible)for(const line of position[i]?.paths||[]){
    for(let j=1;j<line.length;j++){
      const a=screen(line[j-1]),b=screen(line[j]),dx=b[0]-a[0],dy=b[1]-a[1];
      const t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy||1)));
      const dist=Math.hypot(p[0]-a[0]-t*dx,p[1]-a[1]-t*dy);
      if(dist<best){best=dist;found=i;}
    }
  }
  return found;
}
function endPointer(e){
  if(!pointers.has(e.pointerId))return;
  if(e.type==='pointerup'&&!moved&&pointers.size===1){const i=nearestRoad(pointerAt(e));if(i!==null)selectRoad(i,'marker');}
  pointers.delete(e.pointerId);
  if(!pointers.size){surface.classList.remove('dragging');start=null;}
}
for(const event of ['pointerup','pointercancel','lostpointercapture'])surface.addEventListener(event,endPointer);
surface.addEventListener('wheel',e=>{e.preventDefault();const p=pointerAt(e);zoomAt(Math.exp(-Math.max(-160,Math.min(160,e.deltaY))*.004),...p);},{passive:false});
surface.addEventListener('dblclick',e=>{if(!e.target.closest('button'))zoomAt(1.8,...pointerAt(e));});
surface.addEventListener('keydown',e=>{
  if(e.target!==surface)return;
  const delta={ArrowLeft:[-60,0],ArrowRight:[60,0],ArrowUp:[0,-60],ArrowDown:[0,60]}[e.key];
  if(delta){e.preventDefault();camera([view.center[0]+delta[0]/view.scale,view.center[1]+delta[1]/view.scale],view.scale,'free');}
  else if(['+','=','-','0'].includes(e.key)){e.preventDefault();if(e.key==='0') fitRoads();else zoomAt(e.key==='-'?1/1.55:1.55);}
});
function resize(){
  view.width=surface.clientWidth;view.height=surface.clientHeight;
  const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(view.width*dpr);canvas.height=Math.round(view.height*dpr);
  if(view.mode==='city')cityView();else if(view.mode==='all')fitRoads();else if(view.mode==='selected'&&selected!==null)frameSelection(selected);else queueDraw();
}
// A shared area link opens with the same bounds as a manual filter selection.
const initialArea = new URLSearchParams(window.location.search).get('area');
if (archive.areas.includes(initialArea)) area.value = initialArea;
resize();
filter();
new ResizeObserver(resize).observe(surface);

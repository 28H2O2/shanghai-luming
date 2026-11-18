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
  clearRoadTip();
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
function indexFeature(index,kind,name,parts) {
  const box=[Infinity,Infinity,-Infinity,-Infinity];
  for(const flat of parts) for(let i=0;i<flat.length;i+=2){
    const x=flat[i], y=-flat[i+1]*latitudeFactor;
    box[0]=Math.min(box[0],x);box[1]=Math.min(box[1],y);
    box[2]=Math.max(box[2],x);box[3]=Math.max(box[3],y);
  }
  const feature={index,kind,name,box,parts,path:null,anchor:null,length:0};
  if(!grouped.has(kind)) grouped.set(kind,[]);
  grouped.get(kind).push(feature);
}
function preparePath(feature) {
  if(feature.path) return;
  const path=new Path2D();
  let anchor=null,length=0;
  const parts=feature.parts;
  for (const flat of parts) {
    for(let i=0;i<flat.length;i+=2){
      const [x,y]=pointFromPair(flat[i],flat[i+1]);
      if(i===0) path.moveTo(x,y);else path.lineTo(x,y);
      if(i>=2) length+=Math.hypot(x-flat[i-2],y+flat[i-1]*latitudeFactor);
    }
    if(!anchor && flat.length>=4) {
      const mid=2*Math.floor((flat.length/2-1)/2);
      anchor=pointFromPair((flat[mid]+flat[mid+2])/2,(flat[mid+1]+flat[mid+3])/2);
    }
  }
  Object.assign(feature,{path,anchor,length});
}
const grouped = new Map();
const tiles=(geography.tiles || []).map(tile=>{
  const [west,south,east,north]=tile.box;
  return {url:tile.url,box:[west,-north*latitudeFactor,east,-south*latitudeFactor],state:'idle'};
});
if(geography.tiles) {
  for(const row of geography.features) indexFeature(...row);
} else {
  geography.features.forEach((row,index)=>indexFeature(index,...row));
}
const dirtyLayers=new Set();
let loadingTiles=0;
async function loadTile(tile) {
  tile.state='loading';
  loadingTiles++;
  try {
    const response=await fetch(tile.url);
    if(!response.ok) throw new Error(String(response.status));
    const rows=await response.json();
    for(const row of rows) {
      indexFeature(...row);
      dirtyLayers.add(row[1]);
    }
    tile.state='loaded';
  } catch {
    tile.state='failed';
  } finally {
    loadingTiles--;
    queueDraw();
  }
}
function updateTiles(window) {
  const needed=tiles.filter(tile=>inWindow(tile.box,window));
  byId('retry-map').hidden=!needed.some(tile=>tile.state==='failed');
  for(const tile of needed){
    if(loadingTiles>=4) break;
    if(tile.state==='idle') loadTile(tile);
  }
  // Preserve the source's drawing and label priority regardless of network completion order.
  for(const kind of dirtyLayers) grouped.get(kind).sort((a,b)=>a.index-b.index);
  dirtyLayers.clear();
}
byId('retry-map').addEventListener('click',()=>{
  for(const tile of tiles) if(tile.state==='failed') tile.state='idle';
  queueDraw();
});
const localLandmarks=geography.landmarks.points.map(p=>({name:p.name,kind:p.kind,point:project(p.point)}));
const placeLabels=geography.places.map(([name,kind,x,y])=>({name,kind,point:pointFromPair(x,y)}));
const landmarks=[...localLandmarks,...placeLabels.filter(p=>p.kind==='landmark')];
const mapPalette = {
  field:'#e4e8d1',block:'#e6e1d3',green:'#d0dfba',building:'#d8d0bf',water:'#a9cfcd',
  river:'#9bc4c2',canal:'#b0cfcc',rail:'#b7b2a9',lane:'#fffdf5',street:'#fffdf5',
  secondary:'#fffef4',main:'#fffae5',highway:'#ead5a5'
};
const polygonLayers=['field','block','green','building','water'];
const roadLayers=['lane','street','secondary','main','highway'];
const cutoffs={field:0,block:.041,green:0,building:.28,water:0,river:0,canal:.052,rail:.03,lane:.067,street:.046,secondary:.019,main:0,highway:0};
const widths={river:1.7,canal:1,rail:1.1,lane:1.5,street:2.2,secondary:2.9,main:3.8,highway:3.6};
const lineOrder=['river','canal','rail',...roadLayers];
let visibleStreets=[];
function inWindow(box,window) {return box[0]<=window[2] && box[2]>=window[0] && box[1]<=window[3] && box[3]>=window[1];}
function draw() {
  frame=0;
  const {width,height,scale}=view,dpr=canvas.width/Math.max(1,width);
  const [left,top]=world([0,0]), [right,bottom]=world([width,height]);
  const window=[left,top,right,bottom];
  if(tiles.length) updateTiles(window);
  ctx.setTransform(dpr,0,0,dpr,0,0);
  ctx.fillStyle='#eeecdf';ctx.fillRect(0,0,width,height);
  ctx.setTransform(dpr*scale,0,0,dpr*scale,-left*scale*dpr,-top*scale*dpr);
  ctx.lineJoin='round';ctx.lineCap='round';
  const shown={};
  for(const kind of [...polygonLayers,...lineOrder]){
    const layer=scale>=cutoffs[kind]?(grouped.get(kind)||[]):[];
    shown[kind]=layer.filter(f=>inWindow(f.box,window));
    for(const feature of shown[kind]) preparePath(feature);
  }
  visibleStreets=roadLayers.flatMap(kind=>shown[kind]).filter(f=>f.name);
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
  function landmarkLabel(name,point,kind){
    if(used.has(name))return;
    const [x,y]=screen(point),size=13;
    if(x<8||x>width-8||y<12||y>height-12)return;
    const color=kind==='park'?'#426444':kind==='campus'?'#465b70':'#705338';
    ctx.font='600 '+size+'px "PingFang SC","Microsoft YaHei",sans-serif';
    const tw=ctx.measureText(name).width;
    for(const [dx,dy] of [[8,0],[-8-tw,0],[-tw/2,-16],[-tw/2,16],[8,-14],[-8-tw,14]]){
      const tx=x+dx,ty=y+dy;
      const box=[tx-3,ty-9,tx+tw+3,ty+9];
      if(box[0]<2||box[2]>width-2||box[1]<2||box[3]>height-2||collisions.some(b=>inWindow(b,box)))continue;
      collisions.push(box,[x-4,y-4,x+4,y+4]);used.add(name);
      ctx.fillStyle=color;ctx.strokeStyle='#fffdf0';ctx.lineWidth=2;
      ctx.beginPath();
      if(kind==='park'){ctx.arc(x,y,3.8,0,2*Math.PI);}
      else if(kind==='campus'){ctx.rect(x-3.4,y-3.4,6.8,6.8);}
      else {ctx.moveTo(x,y-5);ctx.lineTo(x+4,y);ctx.lineTo(x,y+5);ctx.lineTo(x-4,y);ctx.closePath();}
      ctx.stroke();ctx.fill();ctx.lineWidth=3.3;ctx.textAlign='left';ctx.textBaseline='middle';
      ctx.strokeText(name,tx,ty);ctx.fillText(name,tx,ty);return;
    }
  }
  if(scale>=.02)for(const p of landmarks)landmarkLabel(p.name,p.point,p.kind);
  if(scale>=.12)for(const f of shown.green){
    if(f.name && f.anchor && !used.has(f.name))landmarkLabel(f.name,f.anchor,'park');
  }
  for(const p of placeLabels){
    if(!p.name || used.has(p.name) || p.kind==='landmark')continue;
    const isDistrict=p.kind==='city'||p.name.endsWith('区')&&p.kind==='suburb';
    if(isDistrict ? scale>.17 : scale<(p.kind==='town'?.03:.16))continue;
    if(textLabel(p.name,p.point,isDistrict?15:12,'#697767',isDistrict)) used.add(p.name);
  }
  for(const f of shown.river)if(f.name&&!used.has(f.name)&&f.anchor&&f.length*scale>=65 &&
    textLabel(f.name,f.anchor,14,'#497d7b',true))used.add(f.name);
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
  const button=el('button','mark'+statusClass[r.credibility]);
  button.setAttribute('aria-label','定位'+r.name+'（'+r.district+'）');button.type='button';
  const kind=r.location.kind;button.classList.add(kind);
  byId('marks').append(button);
  const preview=()=>showRoadTip({index:i},[parseFloat(button.style.left),parseFloat(button.style.top)]);
  button.addEventListener('pointerenter',e=>{if(e.pointerType!=='touch')preview();});
  button.addEventListener('focus',preview);
  button.addEventListener('blur',clearRoadTip);
  button.addEventListener('click',()=>selectRoad(i,'marker'));
  return {button};
});
function positionMarkers() {
  const occupied=[];
  const priority=visible.filter(i=>i!==selected);
  if(selected!==null)priority.unshift(selected);
  for(let i=0;i<markerNodes.length;i++) if(markerNodes[i]&&!priority.includes(i))markerNodes[i].button.hidden=true;
  const {width,height}=view;
  const blocked=[[4,3,156,51],[width-43,4,width-5,65],[width-61,height-147,width-3,height-28],[0,height-28,width,height],[0,height-62,182,height-25]];
  for(const i of priority){
    const m=markerNodes[i];if(!m)continue;
    const [x,y]=screen(position[i].point);
    if(x<-10||x>width+10||y<-10||y>height+10){m.button.hidden=true;continue;}
    let mx=x,my=y;
    const overlaps=(a,b)=>occupied.some(box=>inWindow(box,[a-8,b-8,a+8,b+8]));
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
    occupied.push([mx-7,my-7,mx+7,my+7]);
  }
  return [...blocked,...occupied];
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
  clearRoadTip();byId('explore-key').hidden=true;
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
  clearRoadTip();byId('explore-key').hidden=false;
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
byId('about').addEventListener('click',()=>{
  const picture=byId('rules').querySelector('img');
  if(!picture.hasAttribute('src')) picture.src=picture.dataset.src;
  byId('rules').showModal();
});
byId('close').addEventListener('click',()=>byId('rules').close());
byId('rules').addEventListener('click',e=>{
  const b=e.currentTarget.getBoundingClientRect();if(e.clientX<b.left||e.clientX>b.right||e.clientY<b.top||e.clientY>b.bottom)e.currentTarget.close();
});
byId('download-map').addEventListener('click',()=>{
  const link=el('a');link.download='上海鹿鸣-地理数据.json';
  if(geography.download){
    link.href=geography.download;link.click();return;
  }
  const locations=roads.filter(r=>r.location).map(r=>({name:r.name,district:r.district,location:r.location}));
  const url=URL.createObjectURL(new Blob([JSON.stringify({geography,locations})],{type:'application/json'}));
  link.href=url;link.click();
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
  clearRoadTip();
  const p=pointerAt(e);if(!pointers.size){start=p;moved=false;}
  pointers.set(e.pointerId,p);if(pointers.size>1)moved=true;
  surface.setPointerCapture(e.pointerId);surface.classList.add('dragging');
});
surface.addEventListener('pointermove',e=>{
  if(!pointers.has(e.pointerId)){
    if(e.pointerType!=='touch' && !e.target.closest('button')) scheduleHover(pointerAt(e));
    return;
  }
  const prev=gesture(),p=pointerAt(e);pointers.set(e.pointerId,p);
  const next=gesture();
  if(!moved&&start&&Math.hypot(p[0]-start[0],p[1]-start[1])<3)return;
  moved=true;
  if(prev.span>2 && next.span>2)zoomAt(next.span/prev.span,prev.x,prev.y);
  camera([view.center[0]-(next.x-prev.x)/view.scale,view.center[1]-(next.y-prev.y)/view.scale],view.scale,'free');
});
function segmentDistance2(x,y,ax,ay,bx,by){
  const dx=bx-ax, dy=by-ay;
  const t=Math.max(0,Math.min(1,((x-ax)*dx+(y-ay)*dy)/(dx*dx+dy*dy||1)));
  return (x-ax-t*dx)**2+(y-ay-t*dy)**2;
}
function roadAt(p,tolerance=6){
  const [x,y]=world(p), radius=tolerance/view.scale;
  const box=[x-radius,y-radius,x+radius,y+radius];
  let best=radius**2, hit=null;
  for(const index of visible)for(const line of position[index]?.paths||[]){
    for(let j=1;j<line.length;j++){
      const a=line[j-1],b=line[j],d=segmentDistance2(x,y,a[0],a[1],b[0],b[1]);
      if(d<best){best=d;hit={index};}
    }
  }
  if(hit)return hit;
  for(const feature of visibleStreets){
    if(!inWindow(feature.box,box))continue;
    for(const flat of feature.parts)for(let j=2;j<flat.length;j+=2){
      const d=segmentDistance2(x,y,flat[j-2],-flat[j-1]*latitudeFactor,flat[j],-flat[j+1]*latitudeFactor);
      if(d<best){best=d;hit={feature};}
    }
  }
  return hit;
}
const roadTip=byId('road-tip'), trace=byId('hover-path');
let hoverKey=null, hoverFrame=0, hoverPoint=null;
function clearRoadTip(){
  cancelAnimationFrame(hoverFrame);hoverFrame=0;hoverKey=null;
  roadTip.hidden=true;trace.removeAttribute('d');surface.classList.remove('has-road');
}
function showRoadTip(hit,p){
  if(!hit){clearRoadTip();return;}
  cancelAnimationFrame(hoverFrame);hoverFrame=0;
  const key=hit.feature??hit.index;
  if(key!==hoverKey){
    const paths=hit.feature?hit.feature.parts.map(flat=>{
      const line=[];
      for(let i=0;i<flat.length;i+=2)line.push(pointFromPair(flat[i],flat[i+1]));
      return line;
    }):position[hit.index].paths;
    trace.setAttribute('d',paths.map(line=>line.map((point,i)=>(i?'L':'M')+screen(point).join(',')).join(' ')).join(' '));
    roadTip.textContent=hit.feature?hit.feature.name:roads[hit.index].name;
    hoverKey=key;
  }
  roadTip.hidden=false;surface.classList.add('has-road');
  roadTip.style.left=Math.max(4,Math.min(p[0]+10,view.width-roadTip.offsetWidth-4))+'px';
  roadTip.style.top=(p[1]<40?p[1]+15:p[1]-roadTip.offsetHeight-10)+'px';
}
function scheduleHover(p){
  hoverPoint=p;
  if(!hoverFrame)hoverFrame=requestAnimationFrame(()=>{
    hoverFrame=0;showRoadTip(roadAt(hoverPoint),hoverPoint);
  });
}
surface.addEventListener('pointerleave',e=>{if(e.pointerType!=='touch')clearRoadTip();});
surface.addEventListener('keydown',e=>{if(e.key==='Escape')clearRoadTip();});
function endPointer(e){
  if(!pointers.has(e.pointerId))return;
  if(e.type==='pointerup'&&!moved&&pointers.size===1){
    const p=pointerAt(e),hit=roadAt(p,e.pointerType==='touch'?10:6);
    if(hit?.index!==undefined)selectRoad(hit.index,'marker');else showRoadTip(hit,p);
  }
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
  const width=surface.clientWidth,height=surface.clientHeight,dpr=Math.min(devicePixelRatio||1,2);
  const pixelsX=Math.round(width*dpr),pixelsY=Math.round(height*dpr);
  if(view.width===width && view.height===height && canvas.width===pixelsX && canvas.height===pixelsY) return;
  view.width=width;view.height=height;canvas.width=pixelsX;canvas.height=pixelsY;
  if(view.mode==='city')cityView();else if(view.mode==='all')fitRoads();else if(view.mode==='selected'&&selected!==null)frameSelection(selected);else queueDraw();
}
// A shared area link opens with the same bounds as a manual filter selection.
const initialArea = new URLSearchParams(window.location.search).get('area');
if (archive.areas.includes(initialArea)) area.value = initialArea;
resize();
filter();
new ResizeObserver(resize).observe(surface);

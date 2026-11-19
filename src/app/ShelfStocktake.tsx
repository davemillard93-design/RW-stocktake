"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import * as XLSX from "xlsx";
import {openPortraitCamera,drawPortraitFrame,portraitSignatureFromCanvas,estimatePortraitMotion} from "./camera-utils";
type Det={brand:string;product_name:string;subcategory:string;bottle_size_ml:number|null;confidence:number;box:number[];frame_index?:number};
type Row={key:string;brand:string;product:string;type:string;size:number|null;count:number;confidence:number};
type Track={key:string;box:number[];seen:number};
const iou=(a:number[],b:number[])=>{const x=Math.max(0,Math.min(a[2],b[2])-Math.max(a[0],b[0])),y=Math.max(0,Math.min(a[3],b[3])-Math.max(a[1],b[1])),inter=x*y,area=(z:number[])=>Math.max(0,z[2]-z[0])*Math.max(0,z[3]-z[1]);return inter/(area(a)+area(b)-inter||1)};
export default function ShelfStocktake({token,catalogue}:{token:string;catalogue:any[]}){
 const [category,setCategory]=useState("Wine"),[running,setRunning]=useState(false),[rows,setRows]=useState<Row[]>([]),[status,setStatus]=useState("Ready to scan."),[error,setError]=useState("");
 const [manualBrand,setManualBrand]=useState(""),[manualProduct,setManualProduct]=useState(""),[manualSize,setManualSize]=useState(""),[manualQty,setManualQty]=useState("1");
 const video=useRef<HTMLVideoElement>(null),stream=useRef<MediaStream|null>(null),tracks=useRef<Track[]>([]),busy=useRef(false),timer=useRef<any>(null),runningRef=useRef(false),lastSignature=useRef<Uint8ClampedArray|null>(null);
 const stop=useCallback(()=>{runningRef.current=false;if(timer.current)clearTimeout(timer.current);stream.current?.getTracks().forEach(t=>t.stop());stream.current=null;setRunning(false);setStatus("Camera stopped. Review the count.")},[]);
 useEffect(()=>{if(running&&video.current&&stream.current){video.current.srcObject=stream.current;video.current.play().catch(()=>{})}},[running]);
 const scan=useCallback(async()=>{if(!runningRef.current||busy.current||!video.current||video.current.readyState<2||!video.current.videoWidth)return;busy.current=true;try{
  const v=video.current,frames:{image:string;signature:Uint8ClampedArray|null}[]=[];
  for(let i=0;i<2;i++){
   const canvas=document.createElement("canvas");if(!drawPortraitFrame(v,canvas,960))return;
   frames.push({image:canvas.toDataURL("image/jpeg",.7),signature:portraitSignatureFromCanvas(canvas)});
   if(i===0)await new Promise(resolve=>window.setTimeout(resolve,350));
   if(!runningRef.current)return;
  }
  let shiftX=0,shiftY=0;
  const firstMotion=estimatePortraitMotion(lastSignature.current,frames[0].signature);if(firstMotion){shiftX+=firstMotion.dx;shiftY+=firstMotion.dy}
  for(let i=0;i<frames.length-1;i++){const motion=estimatePortraitMotion(frames[i].signature,frames[i+1].signature);if(motion){shiftX+=motion.dx;shiftY+=motion.dy}}
  lastSignature.current=frames[frames.length-1].signature;
  const now=Date.now(),live=tracks.current.filter(t=>now-t.seen<18000).map(t=>({...t,box:[t.box[0]+shiftX,t.box[1]+shiftY,t.box[2]+shiftX,t.box[3]+shiftY]})),used=new Set<Track>(),added:Row[]=[];
  tracks.current=live;
  const knownProducts=catalogue.filter(x=>x.category===category).slice(0,80).map(x=>({id:x.id,brand:x.brand||"",product_name:x.product_name||"",subcategory:x.subcategory||"",bottle_size_ml:x.bottle_size_ml||null}));
  const res=await fetch("/api/count-shelf",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({frames:frames.map(x=>x.image),category,catalogue:knownProducts})}),j=await res.json();if(!res.ok)throw Error(j.error||"Scan failed");if(!runningRef.current)return;
  for(const d of (j.items||[]) as Det[]){const frameIndex=Math.max(0,Math.min(frames.length-1,Number.isInteger(d.frame_index)?Number(d.frame_index):frames.length-1));let box=d.box.slice(0,4);for(let i=frameIndex;i<frames.length-1;i++){const motion=estimatePortraitMotion(frames[i].signature,frames[i+1].signature);if(motion)box=[box[0]+motion.dx,box[1]+motion.dy,box[2]+motion.dx,box[3]+motion.dy]};const key=(category+"|"+d.brand+"|"+d.product_name+"|"+d.bottle_size_ml).toLowerCase();let match:Track|undefined,score=0;for(const t of live){if(used.has(t)||t.key!==key)continue;const q=iou(t.box,box);const ax=(t.box[0]+t.box[2])/2,ay=(t.box[1]+t.box[3])/2,bx=(box[0]+box[2])/2,by=(box[1]+box[3])/2,dist=Math.hypot(ax-bx,ay-by);const w1=t.box[2]-t.box[0],w2=box[2]-box[0],h1=t.box[3]-t.box[1],h2=box[3]-box[1],sizeRatio=Math.min(w1/Math.max(1,w2),w2/Math.max(1,w1),h1/Math.max(1,h2),h2/Math.max(1,h1));const candidate=q>.04||(dist<130&&sizeRatio>.45);const value=candidate?Math.max(q,0.05+(130-dist)/130*0.08):0;if(value>score){score=value;match=t}}if(match&&score>.04){match.box=box;match.seen=now;used.add(match)}else{const t={key,box,seen:now};live.push(t);used.add(t);added.push({key,brand:d.brand,product:d.product_name,type:d.subcategory,size:d.bottle_size_ml,count:1,confidence:d.confidence})}}
  tracks.current=live;if(added.length)setRows(old=>{const n=[...old];for(const a of added){const ix=n.findIndex(x=>x.key===a.key);if(ix>=0)n[ix]={...n[ix],count:n[ix].count+1};else n.push(a)}return n});
  setStatus((j.items||[]).length+" containers in sweep · "+added.length+" new counts. Pan steadily along the shelf.");setError("");
 }catch(e:any){if(runningRef.current){setError(e.message);setStatus("Scanner needs attention.")}}finally{busy.current=false}},[token,category,catalogue]);
 useEffect(()=>{if(!running)return;let cancelled=false;const tick=async()=>{if(cancelled)return;await scan();if(!cancelled)timer.current=window.setTimeout(tick,180)};void tick();return()=>{cancelled=true;if(timer.current)clearTimeout(timer.current)}},[running,scan]);
 async function start(){setError("");setRows([]);tracks.current=[];lastSignature.current=null;try{stream.current=await openPortraitCamera();runningRef.current=true;setRunning(true);setStatus("Camera live. Pan steadily along the shelf.")}catch(e:any){runningRef.current=false;setError(e.name==="NotAllowedError"?"Camera permission denied. Allow access in Safari settings.":e.message||"Could not open camera.")}}
 function change(key:string,delta:number){setRows(old=>old.map(x=>x.key===key?{...x,count:Math.max(0,x.count+delta)}:x).filter(x=>x.count>0))}
 function addManual(){const product=manualProduct.trim();if(!product)return;const brand=manualBrand.trim()||"Manual entry",size=Number(manualSize)||null,key=(category+"|"+brand+"|"+product+"|"+size).toLowerCase(),qty=Math.max(1,Number(manualQty)||1);setRows(old=>{const ix=old.findIndex(x=>x.key===key);if(ix>=0)return old.map((x,i)=>i===ix?{...x,count:x.count+qty}:x);return [...old,{key,brand,product,type:"Manual",size,count:qty,confidence:1}]});setManualBrand("");setManualProduct("");setManualSize("");setManualQty("1");setStatus("Manually added "+product+".")}
 function exportFile(){const ws=XLSX.utils.json_to_sheet(rows.filter(x=>x.count>0).map(x=>({Category:category,Brand:x.brand,Product:x.product,Type:x.type,"Size (ml)":x.size||"",Count:x.count,"AI confidence":Math.round(x.confidence*100)+"%"})));const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,ws,"Shelf count");XLSX.writeFile(wb,"PourVentory-"+category.replace(" ","-")+"-"+new Date().toISOString().slice(0,10)+".xlsx")}
 const total=rows.reduce((n,x)=>n+x.count,0);
 return <section className="panel" style={{marginBottom:18}}><div className="row"><div><h3>Wine & soft drinks shelf count</h3><p className="muted">Continuous camera count — no capture button or photo uploads.</p></div><b>{total} counted</b></div>
 <div><label>Category</label><select value={category} disabled={running} onChange={e=>setCategory(e.target.value)}><option>Wine</option><option>Soft Drinks</option></select><p className="small">{catalogue.filter(x=>x.category===category).length} products in catalogue</p></div>
 <div className="panel" style={{marginTop:12}}><h3>Add count manually</h3><p className="small">Use this if the scanner misses a product or is unavailable.</p><div className="grid"><div><label>Brand (optional)</label><input value={manualBrand} onChange={e=>setManualBrand(e.target.value)} placeholder="Brand / producer"/></div><div><label>Product name *</label><input value={manualProduct} onChange={e=>setManualProduct(e.target.value)} placeholder="Product name"/></div><div><label>Size (ml)</label><input type="number" min="1" value={manualSize} onChange={e=>setManualSize(e.target.value)} placeholder="e.g. 750"/></div><div><label>Quantity</label><input type="number" min="1" value={manualQty} onChange={e=>setManualQty(e.target.value)}/></div></div><button type="button" className="secondary" onClick={addManual} disabled={running||!manualProduct.trim()}>＋ Add to count</button></div>
 {running?<div style={{marginTop:14,padding:12,border:"1px solid var(--line)",borderRadius:14,background:"#111a15"}}>
 <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:10,marginBottom:9}}>
 <span style={{fontSize:12,fontWeight:750,letterSpacing:".06em",color:"var(--accent)"}}>● CAMERA LIVE</span>
 <span className="small">Preview · compact view</span>
 </div>
 <video ref={video} autoPlay playsInline muted className="camera" style={{display:"block",width:"100%",height:"clamp(150px,26vh,220px)",maxHeight:220,objectFit:"cover",borderRadius:10}}/>
 <p className="small" style={{margin:"10px 0 4px"}}>{status}</p>
 <p className="small" style={{margin:"0 0 12px"}}>Pan steadily across the shelf. The scanner compares consecutive frames, matches labels to the catalogue, and compensates for camera movement.</p>
 <button className="secondary full" onClick={stop}>Finish scanning</button>
 </div>:<button onClick={start}>Start continuous camera</button>}
 {error&&<p className="error">{error}</p>}<h3 style={{marginTop:16}}>Count sanity check</h3>{rows.length===0?<p className="muted">Detected products will appear here.</p>:rows.map(x=><div className="item" key={x.key}><div style={{flex:1}}><b>{x.brand}</b><div className="small">{x.product}{x.type?" · "+x.type:""}{x.size?" · "+x.size+"ml":""}</div></div><button className="secondary" disabled={running} onClick={()=>change(x.key,-1)}>−</button><b>{x.count}</b><button className="secondary" disabled={running} onClick={()=>change(x.key,1)}>＋</button></div>)}
 <div className="actions" style={{marginTop:14}}><button disabled={!rows.length||running} onClick={exportFile}>Export to Excel</button><button className="secondary" disabled={!rows.length||running} onClick={()=>{setRows([]);tracks.current=[]}}>Clear count</button></div><p className="small">Review and adjust the totals before exporting. Partly hidden containers may be missed or misidentified.</p></section>
}


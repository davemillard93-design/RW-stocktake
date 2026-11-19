import {NextRequest,NextResponse} from "next/server";
import {createClient} from "@supabase/supabase-js";
export const runtime="nodejs";
export async function POST(req:NextRequest){try{
 const token=(req.headers.get("authorization")||"").replace(/^Bearer /,"");if(!token)return NextResponse.json({error:"Please sign in first."},{status:401});
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{global:{headers:{Authorization:"Bearer "+token}}});
 const {data:{user},error}=await sb.auth.getUser(token);if(error||!user)return NextResponse.json({error:"Session expired."},{status:401});
 const {data:member}=await sb.from("workspace_members").select("workspace_id").eq("user_id",user.id).limit(1).maybeSingle();if(!member)return NextResponse.json({error:"No workspace access."},{status:403});
 const {image,category}=await req.json();if(!["Wine","Soft Drinks"].includes(category)||typeof image!=="string")return NextResponse.json({error:"Invalid shelf frame."},{status:400});
 const key=process.env.GEMINI_API_KEY;if(!key)return NextResponse.json({error:"Gemini scanner key is not configured."},{status:503});
 const m=image.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);if(!m)return NextResponse.json({error:"Invalid camera frame."},{status:400});
 const prompt="Detect every individual full, closed "+(category==="Wine"?"wine bottle":"soft drink bottle, can or carton")+" in this shelf image. Count identical containers separately. Ignore opened, partially used or empty containers, spirits, people, shelf labels and posters. Read brand/product only when legible; otherwise say Unknown. Return JSON only: {\"items\":[{\"brand\":\"...\",\"product_name\":\"...\",\"subcategory\":\"...\",\"bottle_size_ml\":null,\"confidence\":0.8,\"box\":[left,top,right,bottom]}]}. Bounding box coordinates are normalized integers 0-1000. Include each separate visible container with its own box. If none, items is empty.";
 const models=["gemini-3.8-flash","gemini-3.5-flash","gemini-3.5-flash-lite","gemini-2.5-flash"];
 let payload:any=null,lastStatus=503,lastError="AI models are temporarily unavailable.";
 for(const model of models){
  let response:Response;
  try{response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+encodeURIComponent(key),{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(25000),body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:m[1],data:m[2]}}]}],generationConfig:{temperature:0.1,responseMimeType:"application/json",maxOutputTokens:1800}})});}
  catch(e:any){lastStatus=503;lastError=e?.name==="TimeoutError"?"The image scan timed out on "+model+".":String(e?.message||"Network error");continue;}
  const raw=await response.text();
  if(response.ok){try{payload=JSON.parse(raw);break;}catch{lastStatus=502;lastError="Gemini returned invalid JSON.";continue;}}
  lastStatus=response.status;lastError=raw.slice(0,200);
  if(![429,500,502,503,504,404].includes(response.status))return NextResponse.json({error:"Shelf scanner returned "+response.status+". "+lastError},{status:502});
  if([429,503,504].includes(response.status))await new Promise(r=>setTimeout(r,500));
 }
 if(!payload)return NextResponse.json({error:"All shelf-scanning models are currently unavailable. Last response: "+lastStatus+". "+lastError},{status:503});
 const txt=payload.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||"").join("")||"",parsed=JSON.parse(txt);
 const items=Array.isArray(parsed.items)?parsed.items.filter((x:any)=>Array.isArray(x.box)&&x.box.length===4&&Number(x.confidence)>=0.55).map((x:any)=>({brand:String(x.brand||"Unknown"),product_name:String(x.product_name||"Unknown"),subcategory:String(x.subcategory||""),bottle_size_ml:Number(x.bottle_size_ml)||null,confidence:Number(x.confidence)||0,box:x.box.map((n:any)=>Math.max(0,Math.min(1000,Number(n)||0)))})):[];
 return NextResponse.json({items});
}catch(e:any){return NextResponse.json({error:e?.message||"Shelf scan failed."},{status:500});}}

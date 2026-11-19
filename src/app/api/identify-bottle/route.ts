import {NextRequest,NextResponse} from "next/server";
import {createClient} from "@supabase/supabase-js";
export const runtime="nodejs";
function unpackImage(dataUrl:string){const m=dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);if(!m)throw new Error("Invalid image format.");return {mimeType:m[1],data:m[2]};}
export async function POST(req:NextRequest){try{
 const token=(req.headers.get("authorization")||"").replace(/^Bearer /,"");if(!token)return NextResponse.json({error:"Please sign in first."},{status:401});
 const sb=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,{global:{headers:{Authorization:"Bearer "+token}}});
 const {data:{user},error}=await sb.auth.getUser(token);if(error||!user)return NextResponse.json({error:"Your session has expired. Please sign in again."},{status:401});
 const {data:member}=await sb.from("workspace_members").select("workspace_id").eq("user_id",user.id).limit(1).maybeSingle();if(!member)return NextResponse.json({error:"No workspace access."},{status:403});
 const {image}=await req.json();if(typeof image!=="string"||!image.startsWith("data:image/"))return NextResponse.json({error:"Take a clear product image first."},{status:400});
 const key=process.env.GEMINI_API_KEY;if(!key)return NextResponse.json({error:"Gemini scanner key is not configured."},{status:503});const img=unpackImage(image);
 const prompt="Identify the packaged drink product in this photo. Read the exact brand and product name from the visible label. Classify category as exactly one of Spirits, Wine, Soft Drinks. For Spirits, set spirit_type to one of Gin, Vodka, Rum, Whisky, Tequila, Mezcal, Brandy, Liqueur, Other. For Wine, set subcategory to a type such as Red, White, Rose, Sparkling or Fortified. For Soft Drinks, set subcategory to the product type such as Cola, Lemonade, Tonic, Mixer, Juice or Water. Determine bottle_size_ml from the label when visible; otherwise use null. Return JSON only with keys category, brand, product_name, spirit_type, subcategory, bottle_size_ml, confidence, notes. Only identify a product when its brand and product name are legible and confidence is at least 0.75. If uncertain or the label is not readable, return empty brand and product_name. Never invent a brand, product or size.";
 let response:Response|null=null,raw="",lastStatus=503,lastMessage="Recognition service unavailable.";
 for(const model of ["gemini-3.5-flash-lite","gemini-3.6-flash","gemini-3.8-flash"]){
  for(let attempt=0;attempt<2;attempt++){
   try{response=await fetch("https://generativelanguage.googleapis.com/v1beta/models/"+model+":generateContent?key="+encodeURIComponent(key),{method:"POST",headers:{"Content-Type":"application/json"},signal:AbortSignal.timeout(22000),body:JSON.stringify({contents:[{role:"user",parts:[{text:prompt},{inline_data:{mime_type:img.mimeType,data:img.data}}]}],generationConfig:{temperature:0.1,responseMimeType:"application/json",maxOutputTokens:500}})});}
   catch(e:any){lastStatus=503;lastMessage=e?.name==="TimeoutError"?"Recognition timed out on "+model:String(e?.message||"Network error");if(attempt===0)await new Promise(r=>setTimeout(r,700));continue;}
   raw=await response.text();if(response.ok)break;lastStatus=response.status;lastMessage=raw.slice(0,300);
   if(![429,500,502,503,504].includes(response.status))break;
   if(attempt===0)await new Promise(r=>setTimeout(r,700));
  }
  if(response?.ok)break;
  if(![404,429,500,502,503,504].includes(lastStatus))break;
  console.warn("Product recognition model unavailable; trying fallback",model,lastStatus,lastMessage.slice(0,220));
 }
 if(!response?.ok)return NextResponse.json({error:"Product recognition failed ("+lastStatus+"). "+lastMessage.slice(0,220)},{status:502});
 const payload=JSON.parse(raw),output=payload.candidates?.[0]?.content?.parts?.map((p:any)=>p.text||"").join("")||"";
 const cleaned=output.trim().replace(/^\x60{3}(?:json)?\s*/i,"").replace(/\s*\x60{3}$/,"");
 const detection=JSON.parse(cleaned);return NextResponse.json({detection});
 }catch(e:any){console.error("Product identification failed",e);return NextResponse.json({error:e?.message||"Product identification failed."},{status:500});}}

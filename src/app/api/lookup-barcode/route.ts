import {NextRequest,NextResponse} from "next/server";

export const runtime="nodejs";

export async function GET(request:NextRequest){
  const code=(request.nextUrl.searchParams.get("code")||"").replace(/\D/g,"");
  if(!/^\d{8,14}$/.test(code))return NextResponse.json({found:false,error:"Enter a valid 8–14 digit barcode."},{status:400});
  try{
    const url="https://world.openfoodfacts.org/api/v3/product/"+encodeURIComponent(code)+".json?fields=product_name,brands,quantity,categories,image_url";
    const response=await fetch(url,{headers:{"User-Agent":"PourVentory/1.0 (stock catalogue)"},next:{revalidate:86400}});
    if(!response.ok)return NextResponse.json({found:false,error:"Product database unavailable."},{status:502});
    const data=await response.json();
    const product=data?.product;
    if(data?.status!==1||!product)return NextResponse.json({found:false});
    const quantity=String(product.quantity||"");
    const match=quantity.match(/(500|700|750|1000|1500)\s*(?:ml|mL)/i)||quantity.match(/(0\.5|0\.7|0\.75|1|1\.5)\s*l/i);
    let size="700";
    if(match){const n=Number(match[1]);size=String(n<10?n*1000:n);}
    return NextResponse.json({found:true,product:{name:String(product.product_name||"").trim(),brand:String(product.brands||"").split(",")[0].trim(),size,category:String(product.categories||"").split(",").slice(0,3).join(" "),image:product.image_url||null}});
  }catch{return NextResponse.json({found:false,error:"Could not contact the product database."},{status:502});}
}

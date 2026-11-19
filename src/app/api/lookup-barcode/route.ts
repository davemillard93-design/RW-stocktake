import {NextRequest,NextResponse} from "next/server";
import {parseBottleSizeMl} from "../../product-utils";

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
    const size=parseBottleSizeMl(quantity);
    return NextResponse.json({found:true,product:{name:String(product.product_name||"").trim(),brand:String(product.brands||"").split(",")[0].trim(),size:size?String(size):"",quantity,category:String(product.categories||"").split(",").slice(0,3).join(" "),image:product.image_url||null}});
  }catch{return NextResponse.json({found:false,error:"Could not contact the product database."},{status:502});}
}

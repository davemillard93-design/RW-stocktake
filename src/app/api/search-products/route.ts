import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { formatProductSize, parseBottleSizeMl } from "../../product-utils";

export const runtime = "nodejs";

function textValue(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value) && value.length) return String(value[0]).trim();
  }
  return "";
}

export async function GET(request: NextRequest) {
  const query = (request.nextUrl.searchParams.get("q") || "").trim().slice(0, 120);
  if (query.length < 2) return NextResponse.json({ error: "Enter at least two letters to search." }, { status: 400 });

  const token = (request.headers.get("authorization") || "").replace(/^Bearer /, "");
  if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

  try {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { global: { headers: { Authorization: "Bearer " + token } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401 });
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member) return NextResponse.json({ error: "No workspace access." }, { status: 403 });

    const response = await fetch("https://search.openfoodfacts.org/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "PourVentory/1.0 (https://pourventory.vercel.app; product lookup)",
      },
      body: JSON.stringify({
        q: query,
        fields: ["code", "product_name", "product_name_en", "brands", "quantity", "product_quantity", "product_quantity_unit", "categories", "categories_tags", "image_url"],
        page_size: 8,
        page: 1,
        langs: ["en"],
        boost_phrase: true,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) {
      console.warn("Open Food Facts product search returned", response.status);
      return NextResponse.json({ error: "Product search is temporarily unavailable. You can still enter the details manually." }, { status: 503 });
    }

    const data: any = await response.json();
    const hits: any[] = Array.isArray(data?.hits?.hits) ? data.hits.hits
      : Array.isArray(data?.hits) ? data.hits
      : Array.isArray(data?.products) ? data.products
      : Array.isArray(data?.results) ? data.results
      : [];
    const seen = new Set<string>();
    const results = hits.flatMap(hit => {
      const product = hit?._source || hit?.source || hit?.document || hit;
      const name = textValue(product?.product_name, product?.product_name_en, product?.name, product?.title);
      if (!name) return [];
      const brand = textValue(product?.brands, product?.brand);
      const quantity = textValue(product?.quantity, formatProductSize(product?.product_quantity, product?.product_quantity_unit));
      const barcode = textValue(product?.code, product?.barcode, product?._id, hit?._id);
      const key = [brand.toLowerCase(), name.toLowerCase(), quantity.toLowerCase()].join("|");
      if (seen.has(key)) return [];
      seen.add(key);
      return [{
        name,
        brand,
        quantity,
        sizeMl: parseBottleSizeMl(quantity),
        barcode,
        image: textValue(product?.image_url, product?.image_front_url),
        categories: textValue(product?.categories, product?.categories_tags),
      }];
    }).slice(0, 8);

    return NextResponse.json({ results });
  } catch (error: any) {
    console.error("Product search failed", error?.message || error);
    return NextResponse.json({ error: "Could not reach product search. You can still enter the details manually." }, { status: 503 });
  }
}

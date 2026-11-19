import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

function unpackImage(dataUrl: string) {
  const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
  if (!match) throw new Error("Invalid image format.");
  return { mimeType: match[1], data: match[2] };
}

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export async function POST(req: NextRequest) {
  try {
    const token = (req.headers.get("authorization") || "").replace(/^Bearer /, "");
    if (!token) return NextResponse.json({ error: "Please sign in first." }, { status: 401 });

    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      { global: { headers: { Authorization: "Bearer " + token } } },
    );
    const { data: { user }, error } = await supabase.auth.getUser(token);
    if (error || !user) return NextResponse.json({ error: "Your session has expired. Please sign in again." }, { status: 401 });
    const { data: member } = await supabase.from("workspace_members").select("workspace_id").eq("user_id", user.id).limit(1).maybeSingle();
    if (!member) return NextResponse.json({ error: "No workspace access." }, { status: 403 });

    const { image } = await req.json();
    if (typeof image !== "string" || !image.startsWith("data:image/")) return NextResponse.json({ error: "Take a clear product image first." }, { status: 400 });
    const key = process.env.GEMINI_API_KEY;
    if (!key) return NextResponse.json({ error: "Gemini scanner key is not configured." }, { status: 503 });
    const img = unpackImage(image);

    const prompt = `Identify the single packaged drink in this close-up product photo. Read brand and product_name from text that is actually visible on the label; do not infer a brand from bottle shape, color, or a familiar design. Classify category as exactly one of Spirits, Wine, Soft Drinks. For Spirits, spirit_type must be one of Gin, Vodka, Rum, Whisky, Tequila, Mezcal, Brandy, Liqueur, Other. For Wine, set subcategory to a visible style such as Red, White, Rose, Sparkling, or Fortified. For Soft Drinks, use a type such as Cola, Lemonade, Tonic, Mixer, Juice, or Water. Read bottle_size_ml from a visible label only, otherwise use null. If the label is blurred, partly hidden, or ambiguous, return empty brand and product_name. Never invent a product, size, or brand. Return JSON only with keys category, brand, product_name, spirit_type, subcategory, bottle_size_ml, confidence, notes.`;

    let response: Response | null = null;
    let raw = "";
    let lastStatus = 503;
    let lastMessage = "Recognition service unavailable.";
    for (const model of ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"]) {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          response = await fetch("https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent?key=" + encodeURIComponent(key), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(22000),
            body: JSON.stringify({
              contents: [{ role: "user", parts: [{ text: prompt }, { inline_data: { mime_type: img.mimeType, data: img.data } }] }],
              generationConfig: { temperature: 0.1, responseMimeType: "application/json", maxOutputTokens: 500 },
            }),
          });
        } catch (e: any) {
          lastStatus = 503;
          lastMessage = e?.name === "TimeoutError" ? "Recognition timed out on " + model : String(e?.message || "Network error");
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700));
          continue;
        }

        raw = await response.text();
        if (response.ok) break;
        lastStatus = response.status;
        lastMessage = raw.slice(0, 300);
        if (![429, 500, 502, 503, 504].includes(response.status)) break;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 700));
      }
      if (response?.ok) break;
      if (![404, 429, 500, 502, 503, 504].includes(lastStatus)) break;
      console.warn("Product recognition model unavailable; trying fallback", model, lastStatus, lastMessage.slice(0, 220));
    }

    if (!response?.ok) return NextResponse.json({ error: "Product recognition failed (" + lastStatus + "). " + lastMessage.slice(0, 220) }, { status: 502 });
    const payload = JSON.parse(raw);
    const output = payload.candidates?.[0]?.content?.parts?.map((part: any) => part.text || "").join("") || "";
    const cleaned = output.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const result = JSON.parse(cleaned);
    const allowedCategories = ["Spirits", "Wine", "Soft Drinks"];
    const confidence = Number(result.confidence);
    const size = Number(result.bottle_size_ml);
    const detection = {
      category: allowedCategories.includes(result.category) ? result.category : "",
      brand: cleanText(result.brand, 100),
      product_name: cleanText(result.product_name, 140),
      spirit_type: cleanText(result.spirit_type, 40),
      subcategory: cleanText(result.subcategory, 80),
      bottle_size_ml: Number.isFinite(size) && size > 0 ? size : null,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0,
      notes: cleanText(result.notes, 300),
    };
    return NextResponse.json({ detection });
  } catch (e: any) {
    console.error("Product identification failed", e);
    return NextResponse.json({ error: e?.message || "Product identification failed." }, { status: 500 });
  }
}


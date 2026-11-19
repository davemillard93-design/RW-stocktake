export function parseBottleSizeMl(value: unknown): number | null {
  const text = String(value ?? "").toLowerCase().replace(/,/g, ".");
  const match = text.match(/(?:\d+\s*[x×]\s*)?(\d+(?:\.\d+)?)\s*(ml|millilit(?:er|re)s?|cl|centilit(?:er|re)s?|l|lit(?:er|re)s?)\b/i);
  if (!match) return null;

  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "ml" || unit.startsWith("millil") ? 1
    : unit === "cl" || unit.startsWith("centil") ? 10
    : 1000;
  const sizeMl = Math.round(amount * multiplier);
  return Number.isInteger(sizeMl) && sizeMl > 0 && sizeMl <= 20000 ? sizeMl : null;
}

export function formatProductSize(value: unknown, unit: unknown): string {
  const amount = String(value ?? "").trim();
  const measure = String(unit ?? "").trim();
  return amount && measure ? amount + " " + measure : amount || measure;
}

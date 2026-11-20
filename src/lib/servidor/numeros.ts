// Conferência dos números citados em textos gerados por IA contra os dados de origem.

/** Todos os números que aparecem nos dados, nos formatos em que podem ser escritos. */
export function numerosPermitidos(dados: unknown) {
  const ok = new Set<string>();
  const add = (n: number) => {
    for (const v of [n, Math.round(n), Math.round(n * 10) / 10, Math.abs(n)]) {
      ok.add(String(v)); ok.add(String(v).replace(".", ","));
      ok.add(v.toLocaleString("pt-BR")); ok.add(v.toLocaleString("pt-BR", { maximumFractionDigits: 1 }));
      ok.add(v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
    }
  };
  JSON.stringify(dados, (_k, v) => {
    if (typeof v === "number") add(v);
    if (typeof v === "string" && /^\d{4}/.test(v)) v.split(/\D+/).forEach((p: string) => { if (p) ok.add(String(Number(p))); });
    return v;
  });
  for (let a = 2000; a <= 2100; a++) ok.add(String(a)); // anos citados no texto
  for (let i = 1; i <= 12; i++) ok.add(String(i)); // números de seção, meses
  return ok;
}

/** Números citados no texto que não existem nos dados. */
export function conferirNumeros(texto: string, dados: unknown) {
  const ok = numerosPermitidos(dados);
  const citados = texto.match(/\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g) ?? [];
  // Zero à direita depois da vírgula não muda o número: "1,20" vale como "1,2" e "13,0" como "13".
  const semZeros = (c: string) => (c.includes(",") ? c.replace(/0+$/, "").replace(/,$/, "") : c);
  const existe = (c: string) => [c, semZeros(c)].some((f) => ok.has(f) || ok.has(f.replace(/\./g, "")));
  return [...new Set(citados.filter((c) => !existe(c)))];
}

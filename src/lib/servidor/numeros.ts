// Conferência dos números citados em textos gerados por IA contra os dados de origem.

const NUM_TEXTO = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

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
    // Número escrito em texto da fonte ("PLP 299/2026", "Lei 14.133", datas) também vale.
    if (typeof v === "string")
      for (const [c] of v.matchAll(NUM_TEXTO)) {
        ok.add(c);
        add(Number(c.replace(/\./g, "").replace(",", ".")));
      }
    return v;
  });
  for (let a = 2000; a <= 2100; a++) ok.add(String(a)); // anos citados no texto
  for (let i = 1; i <= 12; i++) ok.add(String(i)); // números de seção, meses
  return ok;
}

/** Todos os valores numéricos que aparecem nos dados (para conferir número escrito com escala). */
function valoresNumericos(dados: unknown) {
  const vs: number[] = [];
  JSON.stringify(dados, (_k, v) => {
    if (typeof v === "number" && Number.isFinite(v)) vs.push(Math.abs(v));
    return v;
  });
  return vs;
}

/** Escalas aceitas depois do número (por extenso ou abreviadas), sem acento e em minúsculas. */
const ESCALAS: [RegExp, number][] = [
  [/^trilh|^tri$/, 1e12],
  [/^bilh|^bi$/, 1e9],
  [/^milh|^mi$/, 1e6],
  [/^mil$/, 1e3],
];
const NUM_ESCALA =
  /(\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?)(?:\s*(trilh(?:ão|ões|ao|oes)|bilh(?:ão|ões|ao|oes)|milh(?:ão|ões|ao|oes)|mil|tri|bi|mi)(?![\p{L}\d]))?/giu;

/** Números citados no texto que não existem nos dados. Aceita "5,87 milhões" se algum dado, dividido pela escala e arredondado nas casas escritas, dá o número. */
export function conferirNumeros(texto: string, dados: unknown) {
  const ok = numerosPermitidos(dados);
  const valores = valoresNumericos(dados);
  // Zero à direita depois da vírgula não muda o número: "1,20" vale como "1,2" e "13,0" como "13".
  const semZeros = (c: string) => (c.includes(",") ? c.replace(/0+$/, "").replace(/,$/, "") : c);
  const existe = (c: string) => [c, semZeros(c)].some((f) => ok.has(f) || ok.has(f.replace(/\./g, "")));
  const naEscala = (c: string, palavra: string) => {
    const p = palavra.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    const escala = ESCALAS.find(([re]) => re.test(p))?.[1];
    if (!escala) return false;
    const casas = c.includes(",") ? c.length - c.indexOf(",") - 1 : 0;
    const alvo = Number(c.replace(/\./g, "").replace(",", ".")).toFixed(casas);
    return valores.some((v) => (v / escala).toFixed(casas) === alvo);
  };
  const soltos = new Set<string>();
  for (const [, c, palavra] of texto.matchAll(NUM_ESCALA)) {
    if (c && !existe(c) && !(palavra && naEscala(c, palavra))) soltos.add(c);
  }
  return [...soltos];
}

/**
 * O modelo às vezes escreve decimal com ponto ("46.9%", "R$ 1.28 trilhões"). Troca por vírgula o ponto entre
 * um número e 1 ou 2 dígitos; milhar ("1.234", "1.234.567"), anos e datas com ponto ("20.11.2026") não mudam.
 */
export const normalizarDecimais = (texto: string) =>
  texto.replace(/(?<![\d.])(\d+)\.(\d{1,2})(?![\d.])/g, "$1,$2");

/**
 * Travas editoriais do texto que a IA escreve para cada pauta e decisão:
 *  - todo número precisa existir na fonte oficial (`conferirNumeros`), aceitando o valor grande
 *    escrito por extenso curto ("R$ 6.494.296.446,00" → "R$ 6,5 bilhões");
 *  - regras do Ranking (`violaRegras`): sem termo vetado, sem recomendação de voto;
 *  - título sem sigla nem número de proposição; abertura curta; nada de "polêmica" que a fonte não traz.
 * E o título de reserva, tirado da ementa oficial, quando a IA falha.
 *
 * Módulo puro (o robô o importa direto com Node).
 */
import { conferirNumeros } from "../servidor/numeros.ts";
import { violaRegras } from "../regras.ts";
import type { TextoDidatico } from "./tipos.ts";

const RE_NUMERO = /\d{1,3}(?:\.\d{3})+(?:,\d+)?|\d+(?:,\d+)?/g;

/** Números que aparecem nos textos da fonte, mais as escalas mil/milhão/bilhão dos valores grandes. */
export function numerosDaFonte(textos: string[]): number[] {
  const out = new Set<number>();
  for (const t of textos) {
    for (const bruto of t.match(RE_NUMERO) ?? []) {
      const n = Number(bruto.replace(/\./g, "").replace(",", "."));
      if (!Number.isFinite(n)) continue;
      out.add(n);
      for (const escala of [1e3, 1e6, 1e9, 1e12]) if (n >= escala) out.add(n / escala);
    }
  }
  return [...out];
}

const RE_SIGLA = /\b(PL|PLP|PEC|MPV|MP|PDL|PLV|PRC|PRS|REQ|RQS|ADI|ADC|ADPF|RE|ARE|HC|MS)\b|\bn[º°o]\.?\s*\d/;
const RE_INVENCAO = /pol[êe]mic|controv[ée]rs|repercut|gerou debate|criticad|comemorad|especialistas/i;
/** O leitor não sabe o que é "a fonte" ou "a indexação": o texto fala do assunto, não dos dados. */
const RE_META = /\b(os dados|a fonte|da fonte|a ementa|as palavras-chave|palavras-chave oficiais|a indexa[çc][ãa]o|termos oficiais|termos de indexa[çc][ãa]o)\b/i;

const palavras = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;
const frases = (s: string) => s.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ú"“])/).filter((f) => f.trim()).length;

/** Problemas do texto gerado; lista vazia = pode publicar. */
export function conferirTexto(t: TextoDidatico, fonte: string[]): string[] {
  const problemas: string[] = [];
  const tudo = `${t.titulo}\n${t.abertura}\n${t.detalhes}`;
  const inventados = conferirNumeros(tudo, { n: numerosDaFonte(fonte) });
  if (inventados.length) problemas.push(`números que não estão na fonte: ${inventados.join(", ")}`);
  problemas.push(...violaRegras(tudo));
  if (RE_SIGLA.test(t.titulo)) problemas.push("o título tem sigla ou número de proposição");
  if (palavras(t.titulo) > 15) problemas.push(`o título tem ${palavras(t.titulo)} palavras (máximo 12)`);
  if (frases(t.abertura) > 2 || palavras(t.abertura) > 60) problemas.push("a abertura passou de 2 frases curtas");
  if (RE_META.test(tudo)) problemas.push('o texto fala "dos dados", "da fonte" ou "das palavras-chave" em vez de falar do assunto');
  if (palavras(t.detalhes) > 130) problemas.push("os detalhes passaram de 4 frases curtas");
  if (RE_INVENCAO.test(tudo)) problemas.push("o texto fala de polêmica, crítica ou repercussão, que a fonte não traz");
  return problemas;
}

/** Explicação do glossário da IA só vale sem número que não esteja na fonte. */
export function explicacaoConfere(explicacao: string, fonte: string[]): boolean {
  return conferirNumeros(explicacao, { n: numerosDaFonte(fonte) }).length === 0 && violaRegras(explicacao).length === 0;
}

/**
 * Título de reserva: a ementa oficial encurtada, sem "e dá outras providências" nem "para o fim que
 * especifica". Não reescreve sentido; só corta.
 */
export function tituloDaEmenta(ementa: string, maxPalavras = 18): string {
  let t = ementa.replace(/\s+/g, " ").trim();
  t = t.replace(/[;,]?\s*e d[áa] outras provid[êe]ncias\.?$/i, "").replace(/,?\s*para o fim que especifica\.?$/i, "");
  t = t.split(/;\s/)[0]!.replace(/[.;,\s]+$/, "");
  const ps = t.split(" ");
  if (ps.length > maxPalavras) t = `${ps.slice(0, maxPalavras).join(" ").replace(/[.;,:]+$/, "")}…`;
  return t.charAt(0).toLocaleUpperCase("pt-BR") + t.slice(1);
}

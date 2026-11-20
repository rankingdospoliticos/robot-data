// Regras editoriais do Ranking dos Políticos aplicadas a todo texto gerado automaticamente.
export const TERMOS_VETADOS = ["anticorrupção", "antiprivilégios", "antidesperdício", "nonpartidário", "verdadeiro com ressalvas"];

export const REGRAS_EDITORIAIS = `Você escreve para o Ranking dos Políticos, think tank apartidário.
- Linguagem simples, frases curtas, sem adjetivos desnecessários.
- Nunca recomende voto nem peça apoio ou rejeição a candidato, partido ou parlamentar.
- Trate todos os partidos e governos com o mesmo critério; descreva dados, não intenções.
- Nunca use as palavras: ${TERMOS_VETADOS.join(", ")}. Use "apartidário".
- Só cite números que estejam nos dados fornecidos, exatamente como estão.`;

export function violaRegras(texto: string) {
  const t = texto.toLowerCase();
  const problemas = TERMOS_VETADOS.filter((p) => t.includes(p)).map((p) => `termo vetado: ${p}`);
  if (/\bvote (em|no|na)\b|\bnão vote\b/i.test(texto)) problemas.push("recomendação de voto");
  return problemas;
}

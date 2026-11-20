/**
 * Agregação do arquivo de emendas parlamentares do Portal da Transparência (CGU), por município e
 * por ano. Funções puras, sem rede e sem disco: o robô `scripts/robos/emendas.mjs` as chama e os
 * testes as exercitam com amostras pequenas.
 *
 * Arquivo usado: `EmendasParlamentares_PorFavorecido.csv`, uma linha por pagamento a quem recebeu
 * ("favorecido"), com o município e a UF onde ele tem sede. Colunas lidas: Código da Emenda, Nome do
 * Autor da Emenda, Tipo de Emenda, Ano/Mês (AAAAMM do pagamento), Tipo Favorecido, Natureza Jurídica,
 * UF Favorecido, Município Favorecido e Valor Recebido. CNPJ, CPF e nome de quem recebeu NÃO são
 * lidos adiante: o resultado não tem nenhum dado de favorecido, só somas.
 * Arquivo auxiliar: `EmendasParlamentares.csv` dá a área (função orçamentária) de cada emenda.
 *
 * Este arquivo roda no Node 22.18+ sem compilar (só tipos apagáveis, imports relativos com .ts).
 */

export const TIPOS_DE_EMENDA = ["individual", "pix", "bancada", "comissao", "relator"] as const;
export type TipoDeEmenda = (typeof TIPOS_DE_EMENDA)[number];

/**
 * Quem recebeu, pela natureza jurídica do favorecido:
 *  - pref: prefeitura, fundos, autarquias e fundações do município;
 *  - ent: entidades sem fins lucrativos (associações, fundações privadas, OS, sindicatos...);
 *  - emp: empresas e cooperativas com sede no município;
 *  - out: pessoa física, consórcios públicos, organismos internacionais e natureza não informada;
 *  - gov: governo estadual e federal, estatais e bancos públicos.
 * Só `pref` e `ent` entram no total "que chegou na cidade". Empresa e órgão de governo são pagos pela
 * União onde têm sede (a capital, Brasília, a cidade da matriz), o que não diz onde a obra ou o
 * serviço aconteceu; por isso ficam à parte, sem somar no total.
 */
export const GRUPOS_LOCAIS = ["pref", "ent", "emp", "out"] as const;
export type GrupoLocal = (typeof GRUPOS_LOCAIS)[number];
export type Grupo = GrupoLocal | "gov";
/** Os grupos que somam no total do município. */
export const GRUPOS_DO_TOTAL: readonly Grupo[] = ["pref", "ent"];

export type Municipio = { id: string; nome: string; uf: string };

/** Sem acento, em maiúsculas, só letras e números separados por um espaço. */
export function normalizar(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, " ")
    .trim();
}

/** Divide uma linha de CSV com ";" e aspas duplas. */
export function dividirLinhaCsv(linha: string): string[] {
  const saida: string[] = [];
  let atual = "";
  let aspas = false;
  for (let i = 0; i < linha.length; i++) {
    const c = linha[i]!;
    if (c === '"') {
      if (aspas && linha[i + 1] === '"') {
        atual += '"';
        i++;
      } else aspas = !aspas;
    } else if (c === ";" && !aspas) {
      saida.push(atual);
      atual = "";
    } else atual += c;
  }
  saida.push(atual);
  return saida;
}

/** "1.234,56" → 1234.56; vazio ou lixo → 0. */
export function numeroBR(s: string): number {
  const n = Number(s.trim().replace(/\./g, "").replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

export function tipoDaEmenda(rotulo: string): TipoDeEmenda | null {
  const t = normalizar(rotulo);
  if (t.includes("ESPECIAI")) return "pix";
  if (t.includes("INDIVIDUAL")) return "individual";
  if (t.includes("BANCADA")) return "bancada";
  if (t.includes("COMISSAO")) return "comissao";
  if (t.includes("RELATOR")) return "relator";
  return null;
}

const ENTIDADES = /ASSOCIACAO PRIVADA|FUNDACAO PRIVADA|ORGANIZACAO SOCIAL|SERVICO SOCIAL AUTONOMO|ORGANIZACAO RELIGIOSA|ENTIDADE SINDICAL/;
const GOVERNO = /ESTADUAL|DISTRITO FEDERAL|FEDERAL|ECONOMIA MISTA|^EMPRESA PUBLICA$|PODER JUDICIARIO|PODER LEGISLATIVO/;
const FORA_DO_ROL = /PESSOA FISICA|PRODUTOR RURAL|CONSORCIO PUBLICO|ORGANIZACAO INTERNACIONAL|CLUBE|SEM INFORMACAO/;

/**
 * Em qual grupo cai o pagamento. `null` quando o favorecido não é identificado (inscrição genérica,
 * inválido, sem informação): esse valor não é atribuído a município nenhum.
 */
export function grupoDoRecebedor(tipoFavorecido: string, naturezaJuridica: string): Grupo | null {
  const tf = normalizar(tipoFavorecido);
  const nat = normalizar(naturezaJuridica);
  if (tf.startsWith("UNIDADE GESTORA")) return "gov";
  if (tf.startsWith("INSCRICAO") || tf.startsWith("INVALIDO") || tf === "SEM INFORMACAO") return null;
  if (tf.startsWith("PESSOA FISICA")) return "out";
  if (nat === "MUNICIPIO" || /MUNICIPAL/.test(nat)) return "pref";
  if (GOVERNO.test(nat)) return "gov";
  if (ENTIDADES.test(nat)) return "ent";
  if (!nat || FORA_DO_ROL.test(nat)) return "out";
  return "emp";
}

/* ---------------- casamento de município ---------------- */

/** Grafias da fonte que diferem do nome oficial do IBGE (UF|nome normalizado → nome normalizado do IBGE). */
export const APELIDOS: Record<string, string> = {
  // nomes antigos ou trocados
  "RR|SAO LUIZ": "SAO LUIZ DO ANAUA",
  "SP|EMBU": "EMBU DAS ARTES",
  "RN|ACU": "ASSU",
  "RN|PRESIDENTE JUSCELINO": "SERRA CAIADA",
  "RN|AUGUSTO SEVERO": "CAMPO GRANDE",
  "TO|FORTALEZA DO TABOCAO": "TABOCAO",
  "PB|SERIDO": "SAO VICENTE DO SERIDO",
  // grafia diferente da do IBGE
  "PA|SANTA ISABEL DO PARA": "SANTA IZABEL DO PARA",
  "MT|SANTO ANTONIO DO LEVERGER": "SANTO ANTONIO DE LEVERGER",
  "RS|SANTANA DO LIVRAMENTO": "SANT ANA DO LIVRAMENTO",
  "CE|ITAPAGE": "ITAPAJE",
  "PA|ELDORADO DOS CARAJAS": "ELDORADO DO CARAJAS",
  "PE|IGUARACI": "IGUARACY",
  "MG|BARAO DE MONTE ALTO": "BARAO DO MONTE ALTO",
  "MT|POXOREO": "POXOREU",
  "SE|GRACHO CARDOSO": "GRACCHO CARDOSO",
  "BA|SANTA TERESINHA": "SANTA TEREZINHA",
  "SP|SAO LUIS DO PARAITINGA": "SAO LUIZ DO PARAITINGA",
  "RJ|TRAJANO DE MORAIS": "TRAJANO DE MORAES",
  "SE|AMPARO DE SAO FRANCISCO": "AMPARO DO SAO FRANCISCO",
  "MG|DONA EUSEBIA": "DONA EUZEBIA",
  "MG|BRASOPOLIS": "BRAZOPOLIS",
  "BA|MUQUEM DE SAO FRANCISCO": "MUQUEM DO SAO FRANCISCO",
  "RN|ARES": "AREZ",
  "MG|SAO THOME DAS LETRAS": "SAO TOME DAS LETRAS",
  "SP|FLORINIA": "FLORINEA",
};

export type MapaDeMunicipios = {
  porChave: Map<string, Municipio>;
  /** Chaves com mais de um município no mesmo estado: não se adivinha. */
  ambiguas: Set<string>;
};

export function montarMapa(lista: Municipio[]): MapaDeMunicipios {
  const porChave = new Map<string, Municipio>();
  const ambiguas = new Set<string>();
  for (const m of lista) {
    const k = `${m.uf}|${normalizar(m.nome)}`;
    if (porChave.has(k)) ambiguas.add(k);
    else porChave.set(k, m);
  }
  for (const k of ambiguas) porChave.delete(k);
  return { porChave, ambiguas };
}

export function acharMunicipio(mapa: MapaDeMunicipios, uf: string, nome: string): Municipio | null {
  const u = uf.trim().toUpperCase();
  const n = normalizar(nome);
  if (!u || !n) return null;
  const direto = mapa.porChave.get(`${u}|${n}`);
  if (direto) return direto;
  const apelido = APELIDOS[`${u}|${n}`];
  return apelido ? (mapa.porChave.get(`${u}|${apelido}`) ?? null) : null;
}

/* ---------------- agregação ---------------- */

export type Pagamento = {
  emenda: string;
  autor: string;
  tipoEmenda: string;
  /** AAAAMM. */
  anoMes: string;
  tipoFavorecido: string;
  naturezaJuridica: string;
  uf: string;
  municipio: string;
  valor: number;
};

export type Celula = {
  /** Soma de `pref` e `ent`. */
  total: number;
  porTipo: Partial<Record<TipoDeEmenda, number>>;
  porGrupo: Partial<Record<Grupo, number>>;
  autores: Map<string, number>;
  areas: Map<string, number>;
};

export type Qualidade = {
  linhas: number;
  /** Valor das linhas lidas, todos os grupos, para conferência com o arquivo. */
  valorLido: number;
  linhasSemFavorecidoIdentificado: number;
  valorSemFavorecidoIdentificado: number;
  linhasSemMunicipio: number;
  valorSemMunicipio: number;
  /** Nome de município da fonte que não casou com a lista do IBGE. */
  naoCasaram: Map<string, { linhas: number; valor: number }>;
  linhasSemTipoDeEmenda: number;
};

export type Resultado = {
  /** id IBGE → ano → célula. */
  celulas: Map<string, Map<number, Celula>>;
  qualidade: Qualidade;
};

export function novoResultado(): Resultado {
  return {
    celulas: new Map(),
    qualidade: {
      linhas: 0,
      valorLido: 0,
      linhasSemFavorecidoIdentificado: 0,
      valorSemFavorecidoIdentificado: 0,
      linhasSemMunicipio: 0,
      valorSemMunicipio: 0,
      naoCasaram: new Map(),
      linhasSemTipoDeEmenda: 0,
    },
  };
}

const soma = <K>(m: Map<K, number>, k: K, v: number) => m.set(k, (m.get(k) ?? 0) + v);

/**
 * Soma um pagamento. `areaDaEmenda` devolve a área da emenda quando ela tem uma só; sem área (ou
 * com mais de uma), o valor entra no total mas não em `areas`.
 */
export function somarPagamento(res: Resultado, mapa: MapaDeMunicipios, p: Pagamento, areaDaEmenda: (emenda: string) => string | null): void {
  const q = res.qualidade;
  q.linhas++;
  q.valorLido += p.valor;
  const grupo = grupoDoRecebedor(p.tipoFavorecido, p.naturezaJuridica);
  if (!grupo) {
    q.linhasSemFavorecidoIdentificado++;
    q.valorSemFavorecidoIdentificado += p.valor;
    return;
  }
  const municipio = acharMunicipio(mapa, p.uf, p.municipio);
  if (!municipio) {
    const semNome = !normalizar(p.municipio) || /^-?\d+$/.test(p.municipio.trim()) || normalizar(p.municipio) === "SEM INFORMACAO";
    if (semNome) {
      q.linhasSemMunicipio++;
      q.valorSemMunicipio += p.valor;
    } else {
      const chave = `${p.uf.trim().toUpperCase()}|${normalizar(p.municipio)}`;
      const atual = q.naoCasaram.get(chave) ?? { linhas: 0, valor: 0 };
      atual.linhas++;
      atual.valor += p.valor;
      q.naoCasaram.set(chave, atual);
    }
    return;
  }
  const ano = Number(p.anoMes.slice(0, 4));
  if (!Number.isInteger(ano) || ano < 2000) return;
  let porAno = res.celulas.get(municipio.id);
  if (!porAno) res.celulas.set(municipio.id, (porAno = new Map()));
  let c = porAno.get(ano);
  if (!c) porAno.set(ano, (c = { total: 0, porTipo: {}, porGrupo: {}, autores: new Map(), areas: new Map() }));
  c.porGrupo[grupo] = (c.porGrupo[grupo] ?? 0) + p.valor;
  if (!GRUPOS_DO_TOTAL.includes(grupo)) return;
  const tipo = tipoDaEmenda(p.tipoEmenda);
  if (!tipo) q.linhasSemTipoDeEmenda++;
  c.total += p.valor;
  if (tipo) c.porTipo[tipo] = (c.porTipo[tipo] ?? 0) + p.valor;
  const autor = p.autor.trim();
  if (autor) soma(c.autores, autor, p.valor);
  const area = areaDaEmenda(p.emenda);
  if (area) soma(c.areas, area, p.valor);
}

/** Maiores itens de um mapa, do maior para o menor, só valores positivos. */
export function maiores(m: Map<string, number>, n: number): [string, number][] {
  return [...m.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n);
}

/**
 * Área de cada emenda a partir do arquivo principal: se todas as linhas da emenda têm a mesma
 * função orçamentária, essa é a área; se há mais de uma, `null` (não se divide à mão).
 */
export function areaPorEmenda(linhas: Iterable<{ emenda: string; funcao: string }>): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const { emenda, funcao } of linhas) {
    const f = funcao.trim();
    if (!emenda || normalizar(emenda) === "SEM INFORMACAO" || !f || normalizar(f) === "SEM INFORMACAO") continue;
    if (!m.has(emenda)) m.set(emenda, f);
    else if (m.get(emenda) !== f) m.set(emenda, null);
  }
  return m;
}

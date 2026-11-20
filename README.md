# robot-data

Robôs que coletam dados oficiais e publicam arquivos JSON pequenos, lidos pelo Observatório do Ranking. Rodam no GitHub Actions e gravam no ramo `dados` deste repositório (o ramo é criado na primeira execução).

## O que publicam

| Arquivo | Fonte oficial | Frequência |
| --- | --- | --- |
| `emendas/indice.json` e `emendas/<UF>.json` | Portal da Transparência (arquivo completo de emendas parlamentares), somado por município e ano | diária |
| `brasilia/semana.json` | Votações do Plenário da Câmara e do Senado (dados abertos) e decisões do Plenário do STF (notícias oficiais), com texto didático escrito por IA e conferido automaticamente | de hora em hora em dias úteis e uma vez por madrugada |

## Endereços públicos

- `https://raw.githubusercontent.com/rankingdospoliticos/robot-data/dados/emendas/indice.json`
- `https://raw.githubusercontent.com/rankingdospoliticos/robot-data/dados/emendas/SP.json` (e as demais UFs)
- `https://raw.githubusercontent.com/rankingdospoliticos/robot-data/dados/brasilia/semana.json`

## Não edite o código aqui

Os arquivos em `scripts/` e `src/` são copiados de um repositório privado pelo script `copiar-para-robot-data.mjs` (que vive lá). Qualquer edição feita neste repositório será sobrescrita na próxima cópia. Mudanças no código devem ser feitas na origem.

O workflow de Brasília usa o segredo `ANTHROPIC_API_KEY`; sem ele, publica só o dado oficial.

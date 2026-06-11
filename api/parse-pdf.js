module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ═══ HELPERS DE TEMPO (todo cálculo é em código, nunca pela IA) ═══
  const parseTime = (t) => {
    if (!t) return null;
    const m = String(t).match(/(\d{1,2}):(\d{2})/);
    if (!m) return null;
    let mins = parseInt(m[1]) * 60 + parseInt(m[2]);
    if (/\+1/.test(String(t))) mins += 1440;
    return mins;
  };
  const fmtTime = (mins) => {
    mins = ((mins % 1440) + 1440) % 1440;
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  };
  const durationStr = (s, e) => {
    let a = parseTime(s), b = parseTime(e);
    if (a == null || b == null) return '';
    let d = b - a; if (d < 0) d += 1440;
    return `${Math.floor(d / 60)}h${String(d % 60).padStart(2, '0')}`;
  };
  const durationHoras = (s, e) => {
    let a = parseTime(s), b = parseTime(e);
    if (a == null || b == null) return 0;
    let d = b - a; if (d < 0) d += 1440;
    return Math.round(d / 60);
  };
  const subMinutes = (t, mins) => {
    let v = parseTime(t);
    if (v == null) return '';
    return fmtTime(v - mins);
  };
  const INTL = ['LIS','OPO','FLL','MIA','MCO','JFK','LAX','ORD','CDG','LHR','MAD','FCO','EZE','SCL','BOG','LIM','UIO','PUJ'];
  const isIntl = (iata) => INTL.includes((iata || '').toUpperCase());
  const calcApres = (checkin, dep, intl) => {
    const margin = intl ? 90 : 50;
    const computed = subMinutes(dep, margin);
    const a = parseTime(checkin), d = parseTime(dep);
    if (a == null || d == null) return computed;
    let gap = d - a; if (gap < 0) gap += 1440;
    if (gap < 20 || gap > 240) return computed;
    return fmtTime(a);
  };

  try {
    const { fileData, mediaType, debug } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data' });

    const isImage = (mediaType || '').startsWith('image/');
    const mt = mediaType || 'application/pdf';
    const contentType = isImage ? 'image' : 'document';

    const callAPI = async (messages) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 8000, messages })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || 'API error');
      return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    };

    // ─── STEP 1: TRANSCRIÇÃO CRUA (com data início E data fim) ───────────────
    const rawText = await callAPI([{
      role: 'user',
      content: [
        { type: contentType, source: { type: 'base64', media_type: mt, data: fileData } },
        { type: 'text', text: `Você está lendo uma escala do app "Minha Escala" da Azul Linhas Aéreas.

A tabela tem colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
A coluna Crews é uma sub-tabela com "Crew" (nome) e "Function" (função).
ATENÇÃO: as colunas Start e End têm DATA e HORA (ex: "27 JUN 2026 04:45"). Uma atividade pode começar num dia e terminar em outro.

Sua tarefa é APENAS TRANSCREVER. Não calcule, não interprete. Copie exatamente.

Para CADA linha, gere uma linha no formato (separado por |):
DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS

Campos:
- DATA_INI: a DATA da coluna Start (DD/MM/AAAA).
- DATA_FIM: a DATA da coluna End (DD/MM/AAAA). Pode ser igual ou diferente de DATA_INI.
- ACTIVITY: código exato (AD8750, FR, FP, FC, FA, SB12, RHC22, ADP, ADPOB, Layover).
- CHECKIN: só a HORA da coluna Checkin (HH:MM). Vazio se vazio.
- START: só a HORA da coluna Start (HH:MM).
- END: só a HORA da coluna End (HH:MM).
- DEP: aeroporto origem (3 letras).
- ARR: aeroporto destino (3 letras).
- ACVER: aeronave (763, 772, 32N, 330...).
- DDCAT: coluna DD/CAT (V, COBS, DHD, ou vazio).
- CREWS: tripulantes NOME:FUNCAO separados por vírgula. Vazio se vazio.

IMPORTANTE:
- CHECKIN, START e END são três horas diferentes em colunas diferentes. Não troque a ordem.
- Datas (DD/MM) nunca viram hora (HH:MM).
- Transcreva TODAS as linhas, inclusive ADP, ADPOB, Layover, folgas e sobreavisos.
- Para Layover: DATA_INI | DATA_FIM | Layover | | START | END | LOCAL | LOCAL | | |

Responda só com as linhas, sem explicação.` }
      ]
    }]);

    if (debug) return res.status(200).json({ debug: true, rawText });

    // ─── STEP 2: ESTRUTURA EM JSON (sem cálculos) ────────────────────────────
    const jsonText = await callAPI([{
      role: 'user',
      content: [{
        type: 'text',
        text: `Converta esta transcrição de escala em JSON. NÃO calcule nada — só organize os dados crus.

TRANSCRIÇÃO (formato: DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS):
${rawText}

═══ CLASSIFICAÇÃO (campo "tipo") ═══
FR→"fr"; FP ou PP→"fp"; FC→"fc"; FA(atividade)→"fa"; SB+número→"sb"; RHC...→"rea";
ADP→"adp"; ADPOB→"adpob"; AD####/G3###/LA###/JJ###→"voo"; DHD→"voo" com "dhd":true;
Layover→NÃO é dia próprio, vira "pernoite" do dia do voo anterior.
NUNCA classifique ADP, ADPOB, FC, FA como "fr".

═══ ESTRUTURA POR DIA (dados crus, sem calcular) ═══
{
  "dia": <número do dia de DATA_INI>,
  "diaFim": <número do dia de DATA_FIM>,
  "tipo": "<...>",
  "dhd": <true/false>,
  "checkin": "<CHECKIN do 1º voo, ou vazio>",
  "ddcat": "<DDCAT ou vazio>",
  "local": "<DEP, só para adp/adpob>",
  "sbInicio": "<START, só para sb>",
  "sbFim": "<END, só para sb>",
  "voos": [{"n":"<ACTIVITY>","o":"<DEP>","d":"<ARR>","dp":"<START>","ar":"<END>","ae":"<ACVER>"}],
  "tripulacao": [{"nome":"<NOME>","funcao":"<FUNCAO>"}],
  "pernoite": {"l":"<LOCAL Layover>","ci":"<START layover>","co":"<END layover>"}
}

REGRAS:
- Vários voos na mesma DATA_INI → 1 objeto, todos no array "voos". Tripulação compartilhada.
- Layover vira "pernoite" do dia do voo anterior (não cria dia).
- Funções: CA, FO, CL, FA, FE, SUP. Converta COBS→SUP, V→SUP, DHD→DHD.
- Dias não-voo: "voos":[] e "tripulacao":[].
- "diaFim" é o dia da coluna End — importante para adp/adpob que duram vários dias.
- NÃO calcule duração nem apresentação.

Responda APENAS o JSON, sem texto nem markdown:
{ "mes": "<Mês AAAA>", "dias": [ ... ] }`
      }]
    }]);

    // ─── PARSE + REPAIR ──────────────────────────────────────────────────────
    const extractAndRepair = (text) => {
      let clean = text.replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
      const match = clean.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); }
      catch (e) {
        let t = match[0].replace(/,\s*([}\]])/g, '$1');
        let o = 0, oo = 0;
        for (let c of t) { if (c === '[') o++; else if (c === ']') o--; if (c === '{') oo++; else if (c === '}') oo--; }
        while (o > 0) { t += ']'; o--; } while (oo > 0) { t += '}'; oo--; }
        try { return JSON.parse(t); } catch (e2) { return null; }
      }
    };

    const parsed = extractAndRepair(jsonText);
    if (!parsed || !parsed.dias) {
      return res.status(500).json({ error: 'Falha ao converter JSON', rawExtraction: rawText.substring(0, 2000), rawJson: jsonText.substring(0, 2000) });
    }

    // ═══ PÓS-PROCESSAMENTO EM CÓDIGO (todos os cálculos aqui) ═══
    const labels = { fr: 'Folga', fp: 'Folga Programada', fc: 'Folga Casada', fa: 'Folga Aniversário', voo: 'Voo', rea: 'Reserva', sb: 'Sobreaviso', adp: 'Adaptação', adpob: 'Adaptação fora da base' };

    parsed.dias.forEach(d => {
      d.voos = Array.isArray(d.voos) ? d.voos : [];
      d.tripulacao = Array.isArray(d.tripulacao) ? d.tripulacao : [];
      d.pernoite = d.pernoite && d.pernoite.l ? d.pernoite : null;
      d.dhd = d.dhd === true;
      d.detalhe = d.detalhe || '';
      const ddcat = (d.ddcat || '').toUpperCase();
      d.euroAtlantic = ddcat === 'COBS' || ddcat === 'V';

      if (d.tipo === 'voo' && d.voos.length > 0) {
        d.voos.forEach(v => {
          v.n = v.n || '--'; v.o = (v.o || '--').toUpperCase(); v.d = (v.d || '--').toUpperCase();
          v.dp = v.dp || '--'; v.ar = v.ar || '--'; v.ae = v.ae || '--';
          v.du = durationStr(v.dp, v.ar) || '--';
        });
        const first = d.voos[0];
        const intl = d.voos.some(v => isIntl(v.o) || isIntl(v.d)) || d.euroAtlantic;
        d.apres = calcApres(d.checkin, first.dp, intl);
        d.apresLocal = first.o;
        if (d.pernoite) d.pernoite.int = isIntl(d.pernoite.l);
      }

      if (d.tipo === 'sb') {
        const ini = d.sbInicio || '12:00';
        const fim = d.sbFim || '';
        const horas = fim ? durationHoras(ini, fim) : 12;
        d.sbInicio = ini;
        d.sbFim = fim || fmtTime(parseTime(ini) + horas * 60);
        d.sbHoras = horas;
        d.detalhe = `${d.sbInicio} - ${horas}h`;
      }

      if (d.tipo === 'adp' || d.tipo === 'adpob') {
        d.info = labels[d.tipo] + (d.local ? ` · ${d.local}` : '');
        d.detalhe = d.info;
      }

      d.label = labels[d.tipo] || d.tipo;
    });

    // ----- mapa por dia (voo tem prioridade sobre outras atividades no mesmo dia) -----
    const porDia = {};
    parsed.dias.forEach(d => {
      if (!d.dia) return;
      if (!porDia[d.dia] || porDia[d.dia].tipo !== 'voo') porDia[d.dia] = d;
    });

    // ----- EXPANSÃO multi-dia: adp/adpob que cobrem vários dias -----
    parsed.dias.forEach(d => {
      if ((d.tipo === 'adp' || d.tipo === 'adpob') && d.diaFim && d.diaFim > d.dia) {
        for (let k = d.dia + 1; k <= d.diaFim; k++) {
          const ex = porDia[k];
          if (!ex || ex.tipo === 'fr' || ex.tipo === 'fp') {
            porDia[k] = { dia: k, tipo: d.tipo, label: d.label, detalhe: d.detalhe, info: d.info, dhd: false, euroAtlantic: false, voos: [], tripulacao: [], pernoite: null };
          }
        }
      }
    });

    // ----- preenche todos os dias do mês (sem sobrescrever atividades lidas) -----
    const maxDia = Math.max(...Object.keys(porDia).map(Number), 28);
    const diasFinal = [];
    for (let i = 1; i <= maxDia; i++) {
      if (porDia[i]) diasFinal.push(porDia[i]);
      else diasFinal.push({ dia: i, tipo: 'fr', label: 'Folga', detalhe: '', dhd: false, euroAtlantic: false, voos: [], tripulacao: [], pernoite: null });
    }

    // ----- resumo -----
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    diasFinal.forEach(d => {
      if (d.tipo === 'voo') { resumo.voos += d.voos.length || 1; if (d.pernoite) resumo.pernoites++; }
      else if (['fr', 'fp', 'fc', 'fa'].includes(d.tipo)) resumo.folgas++;
      else if (d.tipo === 'sb') resumo.sb++;
    });

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify({ mes: parsed.mes || 'Junho 2026', resumo, dias: diasFinal }) }]
    });

  } catch (err) {
    console.error('Parser error:', err);
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '10mb' }, maxDuration: 60 } };

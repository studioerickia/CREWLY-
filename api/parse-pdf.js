module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS DE TEMPO — TODO cálculo é feito aqui em código, NUNCA pela IA.
  // ═══════════════════════════════════════════════════════════════════════
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
  const durationStr = (start, end) => {
    let s = parseTime(start), e = parseTime(end);
    if (s == null || e == null) return '';
    let diff = e - s;
    if (diff < 0) diff += 1440;
    return `${Math.floor(diff / 60)}h${String(diff % 60).padStart(2, '0')}`;
  };
  const durationHoras = (start, end) => {
    let s = parseTime(start), e = parseTime(end);
    if (s == null || e == null) return 0;
    let diff = e - s;
    if (diff < 0) diff += 1440;
    return Math.round(diff / 60);
  };
  const subMinutes = (t, mins) => {
    let v = parseTime(t);
    if (v == null) return '';
    return fmtTime(v - mins);
  };

  // Aeroportos internacionais (fora do Brasil)
  const INTL = ['LIS','OPO','FLL','MIA','MCO','JFK','LAX','ORD','CDG','LHR','MAD','FCO','EZE','SCL','BOG','LIM','UIO','PUJ','SCL'];
  const isIntlAirport = (iata) => INTL.includes((iata || '').toUpperCase());

  // Apresentação: usa checkin lido se plausível, senão calcula (50 nac / 90 int)
  const calcApres = (checkin, firstDep, isIntl) => {
    const margin = isIntl ? 90 : 50;
    const computed = subMinutes(firstDep, margin);
    const a = parseTime(checkin), d = parseTime(firstDep);
    if (a == null || d == null) return computed;
    let gap = d - a;
    if (gap < 0) gap += 1440;
    if (gap < 20 || gap > 240) return computed; // checkin implausível → recalcula
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

    // ─── STEP 1: TRANSCRIÇÃO CRUA ────────────────────────────────────────────
    // A IA só copia o que vê. Não calcula nada.
    const rawText = await callAPI([{
      role: 'user',
      content: [
        { type: contentType, source: { type: 'base64', media_type: mt, data: fileData } },
        { type: 'text', text: `Você está lendo uma escala do app "Minha Escala" da Azul Linhas Aéreas.

A tabela tem colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
A coluna Crews é uma sub-tabela com "Crew" (nome) e "Function" (função).

Sua tarefa é APENAS TRANSCREVER fielmente. Não calcule, não interprete, não invente. Copie exatamente o que está escrito.

Para CADA linha da tabela, gere uma linha no formato (separado por |):
DATA | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS

Regras de cada campo:
- DATA: a data da coluna Start, no formato DD/MM/AAAA. NUNCA coloque a data em outro campo.
- ACTIVITY: o código exato (ex: AD8750, FR, FP, FC, FA, SB12, RHC22, ADP, ADPOB, Layover). Copie letra por letra.
- CHECKIN: horário da coluna Checkin (formato HH:MM). Se vazio, deixe vazio.
- START: horário da coluna Start (HH:MM).
- END: horário da coluna End (HH:MM).
- DEP: aeroporto origem (3 letras). Copie completo.
- ARR: aeroporto destino (3 letras). Copie completo.
- ACVER: aeronave (ex: 763, 772, 32N, 330). Copie exato.
- DDCAT: coluna DD/CAT (ex: V, COBS, DHD, ou vazio).
- CREWS: todos os tripulantes no formato NOME:FUNCAO separados por vírgula. Se vazio, deixe vazio.

IMPORTANTE:
- CHECKIN, START e END são TRÊS horários diferentes em colunas diferentes. Não troque a ordem.
- Datas (DD/MM) nunca viram horário (HH:MM). São coisas diferentes.
- Transcreva TODAS as linhas, inclusive ADP, ADPOB, Layover, folgas. Não pule nenhuma.
- Para Layover (pernoite): DATA | Layover | | START | END | LOCAL | LOCAL | | |

Responda apenas com as linhas transcritas, sem explicação.` }
      ]
    }]);

    if (debug) return res.status(200).json({ debug: true, rawText });

    // ─── STEP 2: ESTRUTURA EM JSON (sem cálculos) ────────────────────────────
    // A IA organiza em JSON mas NÃO calcula durações nem apresentação.
    const jsonText = await callAPI([{
      role: 'user',
      content: [{
        type: 'text',
        text: `Converta esta transcrição de escala em JSON. NÃO calcule nada — apenas organize os dados crus.

TRANSCRIÇÃO (formato: DATA | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS):
${rawText}

═══ COMO CLASSIFICAR CADA ATIVIDADE (campo "tipo") ═══
- FR        → "fr"
- FP ou PP  → "fp"
- FC        → "fc"
- FA (quando é a atividade do dia, não função) → "fa"
- SB seguido de número (SB12, SB18...) → "sb"
- RHC ou RHC+número → "rea"
- ADP       → "adp"
- ADPOB     → "adpob"
- AD####, G3###, LA###, JJ### → "voo"
- DHD       → "voo" com "dhd": true
- Layover   → NÃO é dia próprio. Vira "pernoite" do dia do voo anterior.

NUNCA classifique ADP, ADPOB, FC, FA como "fr". Cada código tem seu tipo próprio.

═══ ESTRUTURA DE SAÍDA ═══
Para cada DIA, um objeto com os dados CRUS (sem calcular durações ou apresentação):
{
  "dia": <número>,
  "tipo": "<fr|fp|fc|fa|sb|rea|adp|adpob|voo>",
  "dhd": <true se DHD, senão false>,
  "checkin": "<CHECKIN cru do primeiro voo, ou vazio>",
  "ddcat": "<DDCAT cru, ou vazio>",
  "sbInicio": "<START, só para SB>",
  "sbFim": "<END, só para SB>",
  "voos": [
    {"n":"<ACTIVITY>","o":"<DEP>","d":"<ARR>","dp":"<START>","ar":"<END>","ae":"<ACVER>"}
  ],
  "tripulacao": [{"nome":"<NOME>","funcao":"<FUNCAO>"}],
  "pernoite": {"l":"<LOCAL do Layover>","ci":"<START layover>","co":"<END layover>"} 
}

REGRAS:
- Vários voos na mesma DATA → 1 objeto de dia, todos no array "voos".
- A tripulação é compartilhada pelos voos do mesmo dia.
- Layover vira "pernoite" do dia do voo imediatamente anterior (não cria dia novo).
- Funções da tripulação: CA, FO, CL, FA, FE, SUP. Converta COBS→SUP, V→SUP, DHD→DHD.
- Para dias que não são voo (fr, fp, fc, fa, sb, rea, adp, adpob): "voos" vazio [], "tripulacao" vazio [].
- Inclua TODOS os dias do mês, do 1 ao último. Dia sem nenhuma linha na transcrição = tipo "fr".
- NÃO calcule "du" (duração) nem horário de apresentação. O sistema calcula isso depois.

Identifique o mês e ano pelas datas. Responda APENAS o JSON, sem texto nem markdown:
{
  "mes": "<Mês AAAA>",
  "dias": [ ... ]
}`
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
        let opens = 0, objOpens = 0;
        for (let c of t) {
          if (c === '[') opens++; else if (c === ']') opens--;
          if (c === '{') objOpens++; else if (c === '}') objOpens--;
        }
        while (opens > 0) { t += ']'; opens--; }
        while (objOpens > 0) { t += '}'; objOpens--; }
        try { return JSON.parse(t); } catch (e2) { return null; }
      }
    };

    const parsed = extractAndRepair(jsonText);
    if (!parsed || !parsed.dias) {
      return res.status(500).json({ error: 'Falha ao converter JSON', rawExtraction: rawText.substring(0, 2000), rawJson: jsonText.substring(0, 2000) });
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PÓS-PROCESSAMENTO EM CÓDIGO — aqui acontecem TODOS os cálculos.
    // ═══════════════════════════════════════════════════════════════════════
    const labels = {
      fr: 'Folga', fp: 'Folga Programada', fc: 'Folga Casada',
      fa: 'Folga Aniversário', voo: 'Voo', rea: 'Reserva',
      sb: 'Sobreaviso', adp: 'Adaptação', adpob: 'Adaptação fora da base'
    };

    parsed.dias.forEach(d => {
      d.voos = Array.isArray(d.voos) ? d.voos : [];
      d.tripulacao = Array.isArray(d.tripulacao) ? d.tripulacao : [];
      d.pernoite = d.pernoite && d.pernoite.l ? d.pernoite : null;
      d.dhd = d.dhd === true;
      d.detalhe = d.detalhe || '';

      // euroAtlantic pela coluna DD/CAT
      const ddcat = (d.ddcat || '').toUpperCase();
      d.euroAtlantic = ddcat === 'COBS' || ddcat === 'V';

      // ----- VOO: calcula duração de cada trecho e apresentação do dia -----
      if (d.tipo === 'voo' && d.voos.length > 0) {
        d.voos.forEach(v => {
          v.n = v.n || '--';
          v.o = (v.o || '--').toUpperCase();
          v.d = (v.d || '--').toUpperCase();
          v.dp = v.dp || '--';
          v.ar = v.ar || '--';
          v.ae = v.ae || '--';
          v.du = durationStr(v.dp, v.ar) || '--';  // duração calculada em código
        });
        // apresentação: do primeiro voo. internacional se origem OU destino for intl
        const first = d.voos[0];
        const intl = d.voos.some(v => isIntlAirport(v.o) || isIntlAirport(v.d)) || d.euroAtlantic;
        d.apres = calcApres(d.checkin, first.dp, intl);
        d.apresLocal = first.o;

        // pernoite internacional?
        if (d.pernoite) {
          d.pernoite.int = isIntlAirport(d.pernoite.l);
        }
      }

      // ----- SOBREAVISO: calcula horas reais (END - START) -----
      if (d.tipo === 'sb') {
        const ini = d.sbInicio || '12:00';
        const fim = d.sbFim || '';
        const horas = fim ? durationHoras(ini, fim) : 12;
        d.sbInicio = ini;
        d.sbFim = fim || fmtTime(parseTime(ini) + horas * 60);
        d.sbHoras = horas;
        d.detalhe = `${d.sbInicio} - ${horas}h`;
      }

      // label final
      d.label = labels[d.tipo] || d.tipo;
    });

    // ----- garante todos os dias do mês, sem sobrescrever atividades lidas -----
    const maxDia = Math.max(...parsed.dias.map(d => d.dia || 0), 28);
    const porDia = {};
    parsed.dias.forEach(d => { if (d.dia) porDia[d.dia] = d; });
    const diasFinal = [];
    for (let i = 1; i <= maxDia; i++) {
      if (porDia[i]) diasFinal.push(porDia[i]);
      else diasFinal.push({ dia: i, tipo: 'fr', label: 'Folga', detalhe: '', dhd: false, euroAtlantic: false, voos: [], tripulacao: [], pernoite: null });
    }

    // ----- resumo calculado em código -----
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

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' }, maxDuration: 60 }
};

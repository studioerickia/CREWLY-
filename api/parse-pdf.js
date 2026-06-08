module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { fileData, mediaType } = req.body;
    if (!fileData) return res.status(400).json({ error: 'No file data' });

    const isImage = (mediaType || '').startsWith('image/');
    const mt = mediaType || 'application/pdf';
    const contentType = isImage ? 'image' : 'document';

    const makeRequest = async (prompt) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 8000,
          messages: [{
            role: 'user',
            content: [
              { type: contentType, source: { type: 'base64', media_type: mt, data: fileData } },
              { type: 'text', text: prompt }
            ]
          }]
        })
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message || 'API error');
      return (d.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    };

    const basePrompt = `Esta e uma escala do app "Minha Escala" da Azul Linhas Aereas.

O documento tem uma tabela com colunas: Activity, Checkin, Start, End, Checkout, Dep, Arr, AcVer, DD/CAT, Crews.

Regras para interpretar:
- Linhas com "FR" na coluna Activity = Folga Regular (tipo: fr)
- Linhas com "FP" = Folga Programada (tipo: fp)  
- Linhas com "SB" seguido de numero = Sobreaviso (tipo: sb, detalhe: horario inicio e horas ex "18:00-6h")
- Linhas com "RHC" ou "RHC22" = Reserva (tipo: rea)
- Linhas com codigo de voo como "AD4070", "AD2805", "G3123" = Voo (tipo: voo)
- Linhas com "Layover" = Pernoite, incluir no dia do voo anterior
- Linhas com "ADP" = Adaptacao (tipo: adp)
- Linhas com "PP" = Folga (tipo: fp)

Para cada voo extraia:
- Numero do voo exato da coluna Activity (ex: AD4070, AD2805)
- Origem: coluna Dep (aeroporto de 3 letras ex: VCP, GRU, REC)
- Destino: coluna Arr
- Horario partida: coluna Start
- Horario chegada: coluna End
- Aeronave: coluna AcVer (ex: 32N, 32A, E2, ATR)
- Tripulacao: coluna Crews (lista de nomes e funcoes CA/FO/CL/FA/FE/SUP)

Agrupe todos os voos do mesmo dia em um objeto so.
Identifique o mes e ano pelas datas nas colunas Checkin/Start.`;

    const prompt1 = basePrompt + `

Retorne APENAS JSON valido sem texto adicional para os DIAS 1 A 15:
{"mes":"Junho 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":"","voos":[{"n":"AD4070","o":"VCP","d":"REC","dp":"06:00","ar":"09:00","du":"3h00","ae":"32N"}],"tripulacao":[{"nome":"NOME SOBRENOME","funcao":"CA"}],"pernoite":{"l":"REC","ci":"09:30","co":"15:00"}}]}

Retorne apenas dias 1 a 15. Para dias sem voo use apenas tipo e label, sem voos e tripulacao.`;

    const prompt2 = basePrompt + `

Retorne APENAS JSON valido sem texto adicional para os DIAS 16 AO FIM DO MES:
{"dias":[{"dia":16,"tipo":"fr","label":"Folga","detalhe":"","voos":[{"n":"AD4070","o":"VCP","d":"REC","dp":"06:00","ar":"09:00","du":"3h00","ae":"32N"}],"tripulacao":[{"nome":"NOME SOBRENOME","funcao":"CA"}],"pernoite":{"l":"REC","ci":"09:30","co":"15:00"}}]}

Retorne apenas dias 16 em diante. Para dias sem voo use apenas tipo e label.`;

    const [text1, text2] = await Promise.all([
      makeRequest(prompt1),
      makeRequest(prompt2)
    ]);

    const extractAndRepair = (text) => {
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try { return JSON.parse(match[0]); }
      catch(e) {
        let t = match[0];
        const lastObj = t.lastIndexOf('},');
        if (lastObj > 200) t = t.substring(0, lastObj + 1);
        let opens = 0, objOpens = 0;
        for (let c of t) {
          if (c==='[') opens++; else if (c===']') opens--;
          if (c==='{') objOpens++; else if (c==='}') objOpens--;
        }
        while (opens > 0) { t += ']'; opens--; }
        while (objOpens > 0) { t += '}'; objOpens--; }
        try { return JSON.parse(t); } catch(e2) { return null; }
      }
    };

    const res1 = extractAndRepair(text1);
    const res2 = extractAndRepair(text2);

    if (!res1) return res.status(500).json({ error: 'Nao consegui ler os primeiros 15 dias' });

    // Combina dias
    const diasFinal = [...(res1.dias || [])];
    if (res2 && res2.dias) {
      res2.dias.forEach(d => {
        if (!diasFinal.find(x => x.dia === d.dia)) diasFinal.push(d);
      });
    }
    diasFinal.sort((a, b) => a.dia - b.dia);

    // Calcula resumo real
    const resumo = { voos: 0, pernoites: 0, folgas: 0, sb: 0 };
    diasFinal.forEach(d => {
      if (d.tipo === 'voo') {
        resumo.voos += (d.voos && d.voos.length > 0) ? d.voos.length : 1;
        if (d.pernoite) resumo.pernoites++;
      }
      else if (d.tipo === 'fr' || d.tipo === 'fp') resumo.folgas++;
      else if (d.tipo === 'sb') resumo.sb++;
    });

    return res.status(200).json({
      content: [{ type: 'text', text: JSON.stringify({
        mes: res1.mes || 'Junho 2026',
        resumo,
        dias: diasFinal
      })}]
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: {
    bodyParser: { sizeLimit: '10mb' },
    maxDuration: 60
  }
};

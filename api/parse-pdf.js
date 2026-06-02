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

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: isImage ? 'image' : 'document',
              source: { type: 'base64', media_type: mt, data: fileData }
            },
            {
              type: 'text',
              text: `Voce e especialista em escalas de tripulantes da aviacao brasileira (Azul, Gol, Latam).

Analise esta escala e retorne APENAS JSON valido sem texto adicional.

Formato:
{
  "mes": "Maio 2026",
  "resumo": {"voos": 0, "pernoites": 0, "folgas": 0, "sb": 0},
  "dias": [
    {
      "dia": 1,
      "tipo": "fr",
      "label": "Folga",
      "detalhe": "",
      "voos": [
        {
          "n": "AD4070",
          "o": "VCP",
          "d": "GRU",
          "dp": "06:00",
          "ar": "07:00",
          "du": "1h00",
          "ae": "32N"
        }
      ],
      "tripulacao": [
        {"mat": "12345", "n": "NOME SOBRENOME", "f": "CA"},
        {"mat": "67890", "n": "OUTRO NOME", "f": "FA"}
      ],
      "pernoite": {"l": "GRU", "ci": "22:00", "co": "10:00+1"}
    }
  ]
}

Tipos de dia:
- fr = Folga Regular (FR)
- fp = Folga Programada (FP)
- sb = Sobreaviso (SB18 = inicio 18:00, detalhe: "18:00 - 6h")
- rea = Reserva (REA, RHC)
- voo = Voo (AD, G3, LA)
- adp = Adaptacao internacional (ADP)
- pernoite = Layover

Para dias de VOO extraia:
- Numero do voo (ex: AD4070, AD8750)
- Origem e destino (siglas IATA ex: VCP, GRU, MCO)
- Horario de decolagem e pouso
- Duracao do voo
- Aeronave (32N, 32A, ATR, E1, E2, 330, 33A)
- Tripulacao completa com matricula, nome e funcao (CA, FO, SUP, CL, FA, FE)
- Pernoite se houver (cidade, checkin, checkout)

Para SB extraia horario de inicio e calcule horas ate 23:59.
Identifique mes e ano corretamente.
Agrupe todas atividades do mesmo dia num unico objeto.
Retorne JSON com TODOS os dias do mes.`
            }
          ]
        }]
      })
    });

    const data = await response.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '10mb' } }
};

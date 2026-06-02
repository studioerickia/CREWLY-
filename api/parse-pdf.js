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
              text: 'Analise esta escala de tripulante brasileiro e retorne APENAS JSON valido sem texto adicional: {"mes":"Maio 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":""}]}. Tipos: fr=Folga Regular, fp=Folga Programada, sb=Sobreaviso(detalhe: horario-horas ex 18:00-6h), rea=Reserva/RHC, voo=Voo AD/G3/LA(detalhe: numero do voo), adp=Adaptacao internacional, pernoite=Layover(detalhe: cidade). Identifique mes e ano corretamente. Agrupe voos do mesmo dia. Retorne todos os dias do mes.'
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

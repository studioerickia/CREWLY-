export const config = {
  api: {
    bodyParser: {
      sizeLimit: '10mb',
    },
  },
};

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  
  // Debug: verifica se a chave existe
  if (!apiKey) {
    return res.status(500).json({ 
      error: 'ANTHROPIC_API_KEY not found',
      env: Object.keys(process.env).filter(k => k.includes('ANTHRO'))
    });
  }

  try {
    const body = req.body;
    const fileData = body.fileData;
    const mediaType = body.mediaType;

    if (!fileData) return res.status(400).json({ error: 'No fileData' });

    const isImage = mediaType && mediaType.startsWith('image/');
    
    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [{
          role: 'user',
          content: [
            {
              type: isImage ? 'image' : 'document',
              source: { type: 'base64', media_type: mediaType || 'application/pdf', data: fileData }
            },
            {
              type: 'text',
              text: 'Analise esta escala de tripulante brasileiro. Retorne APENAS JSON: {"mes":"Maio 2026","resumo":{"voos":0,"pernoites":0,"folgas":0,"sb":0},"dias":[{"dia":1,"tipo":"fr","label":"Folga","detalhe":""}]}. Tipos: fr=Folga Regular, fp=Folga Programada, sb=Sobreaviso, rea=Reserva/RHC, voo=Voo AD/G3/LA, adp=Adaptacao, pernoite=Layover. Identifique o mes corretamente. Retorne todos os dias.'
            }
          ]
        }]
      })
    });

    const data = await anthropicRes.json();
    return res.status(200).json(data);

  } catch (err) {
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
}

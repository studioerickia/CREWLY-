module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const googleCredsRaw = process.env.GOOGLE_CREDS;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const AEROPORTOS = ['VCP','GRU','CGH','SDU','GIG','BSB','CNF','CWB','POA','FLN','NVT','JOI',
    'REC','SSA','FOR','NAT','JPA','MCZ','AJU','THE','SLZ','BEL','MAO','PVH','RBR','BVB','MCP',
    'CGB','CGR','GYN','UDI','RAO','SJP','BAU','MGF','LDB','IGU','XAP','PFB','CXJ','PET','IJU',
    'VIX','IPN','GVR','MOC','UNA','IOS','PHB','PNZ','JDO','IMP','PMW','ARU','DOU','BPS','STM',
    'VDC','CZS','LIS','OPO','FLL','MCO','MIA','JFK','PUJ','SCL','MVD','EZE','AEP','ASU'];
  const AERO_SET = new Set(AEROPORTOS);
  const INTL = new Set(['LIS','OPO','FLL','MCO','MIA','JFK','PUJ','SCL','MVD','EZE','AEP','ASU']);
  const DIAS_MES = {janeiro:31,fevereiro:29,'março':31,marco:31,abril:30,maio:31,junho:30,julho:31,agosto:31,setembro:30,outubro:31,novembro:30,dezembro:31};

  const distLev=(a,b)=>{const m=a.length,n=b.length,d=Array.from({length:m+1},(_,i)=>[i,...Array(n).fill(0)]);for(let j=0;j<=n;j++)d[0][j]=j;for(let i=1;i<=m;i++)for(let j=1;j<=n;j++)d[i][j]=Math.min(d[i-1][j]+1,d[i][j-1]+1,d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));return d[m][n];};
  const validarAero=(c)=>{if(!c)return'--';c=String(c).toUpperCase().trim().replace(/[^A-Z0-9]/g,'');if(AERO_SET.has(c))return c;let b=c,n=99;for(const a of AEROPORTOS){const d=distLev(c,a);if(d<n){n=d;b=a;}}return n<=1?b:c;};
  const parseTime=(t)=>{if(!t)return null;const m=String(t).match(/(\d{1,2}):(\d{2})/);if(!m)return null;let x=parseInt(m[1])*60+parseInt(m[2]);if(/\+1/.test(String(t)))x+=1440;return x;};
  const fmtTime=(x)=>{x=((x%1440)+1440)%1440;return`${String(Math.floor(x/60)).padStart(2,'0')}:${String(x%60).padStart(2,'0')}`;};
  const durationStr=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return'';let d=b-a;if(d<0)d+=1440;return`${Math.floor(d/60)}h${String(d%60).padStart(2,'0')}`;};
  const durationHoras=(s,e)=>{let a=parseTime(s),b=parseTime(e);if(a==null||b==null)return 0;let d=b-a;if(d<0)d+=1440;return Math.round(d/60);};
  const subMinutes=(t,m)=>{let v=parseTime(t);if(v==null)return'';return fmtTime(v-m);};
  const isIntl=(i)=>INTL.has((i||'').toUpperCase());
  const calcApres=(checkin,dep,intl)=>{const margin=intl?90:50;const computed=subMinutes(dep,margin);const a=parseTime(checkin),d=parseTime(dep);if(a==null||d==null)return computed;let gap=d-a;if(gap<0)gap+=1440;if(gap<20||gap>240)return computed;return fmtTime(a);};

  // ── GOOGLE VISION OCR ──────────────────────────────────────────────────────
  async function getGoogleToken(creds) {
    const b64url = (d) => {
      if (typeof d === 'string') d = Buffer.from(d);
      return d.toString('base64').replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
    };
    const now = Math.floor(Date.now()/1000);
    const header = b64url(JSON.stringify({alg:'RS256',typ:'JWT'}));
    const payload = b64url(JSON.stringify({
      iss: creds.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-vision',
      aud: creds.token_uri,
      exp: now+3600, iat: now
    }));
    const crypto = require('crypto');
    const sign = crypto.createSign('RSA-SHA256');
    sign.update(`${header}.${payload}`);
    const sig = b64url(sign.sign(creds.private_key));
    const jwt = `${header}.${payload}.${sig}`;

    const body = `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`;
    const r = await fetch(creds.token_uri, {
      method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body
    });
    const d = await r.json();
    if (!d.access_token) throw new Error('Token error: '+JSON.stringify(d));
    return d.access_token;
  }

  async function visionOCR(imgB64, token) {
    const r = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method:'POST',
      headers:{'Authorization':`Bearer ${token}`,'Content-Type':'application/json'},
      body: JSON.stringify({requests:[{image:{content:imgB64},features:[{type:'DOCUMENT_TEXT_DETECTION'}]}]})
    });
    const d = await r.json();
    if (d.error) throw new Error('Vision error: '+d.error.message);
    return d.responses?.[0]?.fullTextAnnotation?.text || '';
  }

  try {
    const {fileData, mediaType} = req.body;
    if (!fileData) return res.status(400).json({error:'No file data'});

    const isImage = (mediaType||'').startsWith('image/');
    let imgB64 = fileData;

    // Extrai JPEG do PDF
    if (!isImage) {
      try {
        const pdf = Buffer.from(fileData,'base64');
        const s = pdf.indexOf(Buffer.from([0xFF,0xD8,0xFF]));
        const e = pdf.lastIndexOf(Buffer.from([0xFF,0xD9]));
        if (s>=0 && e>s) imgB64 = pdf.slice(s,e+2).toString('base64');
      } catch(e) {}
    }

    const callClaude = async (content) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method:'POST',
        headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
        body: JSON.stringify({model:'claude-sonnet-4-6',max_tokens:8000,messages:[{role:'user',content}]})
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
    };

    // ── STEP 1: OCR com Google Vision (texto preciso) OU fallback para Claude ─
    let rawText = '';
    if (googleCredsRaw) {
      try {
        const creds = JSON.parse(googleCredsRaw);
        const token = await getGoogleToken(creds);
        // OCR da imagem completa — Vision API lida com imagens grandes perfeitamente
        rawText = await visionOCR(imgB64, token);
        console.log('Vision OCR OK, chars:', rawText.length);
      } catch(e) {
        console.log('Vision falhou, usando Claude:', e.message);
      }
    }

    // Fallback: Claude lê a imagem diretamente
    if (!rawText) {
      const ct = isImage ? 'image' : 'document';
      const mt = isImage ? mediaType : 'application/pdf';
      rawText = await callClaude([
        {type:ct, source:{type:'base64',media_type:mt,data:fileData}},
        {type:'text', text:`Transcreva esta escala da Azul linha por linha no formato:
DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS
Aeroportos válidos: ${AEROPORTOS.join(', ')}
Responda só as linhas.`}
      ]);
    }

    // ── STEP 2: Claude converte o texto OCR em JSON ───────────────────────────
    const rawTextTrunc = rawText.length > 12000 ? rawText.substring(0, 12000) : rawText;
    const jsonText = await callClaude([{
      type:'text',
      text:`O texto abaixo foi extraído por OCR de uma escala da Azul Linhas Aéreas.
A tabela tem colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews

Converta em JSON. NÃO calcule nada — só organize os dados.

TEXTO OCR:
${rawTextTrunc}

CLASSIFICAÇÃO:
FR→"fr"; FP/PP→"fp"; FC→"fc"; FA(atividade)→"fa"; SB+nº→"sb"; RHC...→"rea";
ADP→"adp"; ADPOB→"adpob"; AD####/G3###/LA###/JJ###→"voo"; DHD→"voo"+"dhd":true;
Layover→pernoite do dia do voo anterior. NUNCA classifique ADP/ADPOB/FC/FA como "fr".

POR DIA: {"dia":<nº>,"diaFim":<nº>,"tipo":"...","dhd":<bool>,
"checkin":"<hora checkin>","ddcat":"<ddcat>","local":"<dep só adp/adpob>",
"sbInicio":"<start sb>","sbFim":"<end sb>",
"voos":[{"n":"<activity>","o":"<dep>","d":"<arr>","dp":"<start>","ar":"<end>","ae":"<acver>"}],
"tripulacao":[{"nome":"<nome>","funcao":"<funcao>"}],
"pernoite":{"l":"<local>","ci":"<start layover>","co":"<end layover>"}}

Vários voos mesma data → 1 objeto. Funções: CA,FO,CL,FA,FE,SUP (COBS→SUP,V→SUP,DHD→DHD).
Dias não-voo: voos:[] e tripulacao:[]. NÃO calcule duração nem apresentação.
Responda APENAS: {"mes":"<Mês AAAA>","dias":[...]}`
    }]);

    const extractAndRepair=(t)=>{let c=t.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();const m=c.match(/\{[\s\S]*\}/);if(!m)return null;try{return JSON.parse(m[0]);}catch(e){let x=m[0].replace(/,\s*([}\]])/g,'$1');let o=0,oo=0;for(let ch of x){if(ch==='[')o++;else if(ch===']')o--;if(ch==='{')oo++;else if(ch==='}')oo--;}while(o>0){x+=']';o--;}while(oo>0){x+='}';oo--;}try{return JSON.parse(x);}catch(e2){return null;}}};

    const parsed = extractAndRepair(jsonText);
    if (!parsed||!parsed.dias) return res.status(500).json({error:'Falha JSON',rawText:rawText.substring(0,1000)});

    const mesNome=(parsed.mes||'junho 2026').toLowerCase().split(' ')[0];
    const diasNoMes=DIAS_MES[mesNome]||31;
    const labels={fr:'Folga',fp:'Folga Programada',fc:'Folga Casada',fa:'Folga Aniversário',voo:'Voo',rea:'Reserva',sb:'Sobreaviso',adp:'Adaptação',adpob:'Adaptação fora da base'};

    parsed.dias=parsed.dias.filter(d=>d&&d.dia>=1&&d.dia<=diasNoMes);

    parsed.dias.forEach(d=>{
      d.voos=Array.isArray(d.voos)?d.voos:[];
      d.tripulacao=Array.isArray(d.tripulacao)?d.tripulacao:[];
      d.pernoite=d.pernoite&&d.pernoite.l?d.pernoite:null;
      d.dhd=d.dhd===true; d.detalhe=d.detalhe||'';
      const ddcat=(d.ddcat||'').toUpperCase();
      d.euroAtlantic=ddcat==='COBS'||ddcat==='V';
      if(d.tipo==='voo'&&d.voos.length>0){
        d.voos.forEach(v=>{v.n=v.n||'--';v.o=validarAero(v.o);v.d=validarAero(v.d);v.dp=v.dp||'--';v.ar=v.ar||'--';v.ae=v.ae||'--';v.du=durationStr(v.dp,v.ar)||'--';});
        const first=d.voos[0];
        const intl=d.voos.some(v=>isIntl(v.o)||isIntl(v.d))||d.euroAtlantic;
        d.apres=calcApres(d.checkin,first.dp,intl);
        d.apresLocal=first.o;
        if(d.pernoite){d.pernoite.l=validarAero(d.pernoite.l);d.pernoite.int=isIntl(d.pernoite.l);}
      }
      if(d.tipo==='sb'){
        const ini=d.sbInicio||'12:00';const fim=d.sbFim||'';
        const horas=fim?durationHoras(ini,fim):12;
        d.sbInicio=ini;d.sbFim=fim||fmtTime(parseTime(ini)+horas*60);
        d.sbHoras=horas;d.detalhe=`${d.sbInicio} - ${horas}h`;
      }
      if(d.tipo==='adp'||d.tipo==='adpob'){
        const loc=d.local?validarAero(d.local):'';
        d.info=labels[d.tipo]+(loc?` · ${loc}`:'');d.detalhe=d.info;
      }
      d.label=labels[d.tipo]||d.tipo;
    });

    const porDia={};
    parsed.dias.forEach(d=>{if(!porDia[d.dia]||porDia[d.dia].tipo!=='voo')porDia[d.dia]=d;});
    parsed.dias.forEach(d=>{
      if((d.tipo==='adp'||d.tipo==='adpob')&&d.diaFim&&d.diaFim>d.dia){
        const fim=Math.min(d.diaFim,diasNoMes);
        for(let k=d.dia+1;k<=fim;k++){
          const ex=porDia[k];
          if(!ex||ex.tipo==='fr'||ex.tipo==='fp')
            porDia[k]={dia:k,tipo:d.tipo,label:d.label,detalhe:d.detalhe,info:d.info,dhd:false,euroAtlantic:false,voos:[],tripulacao:[],pernoite:null};
        }
      }
    });

    const diasFinal=[];
    for(let i=1;i<=diasNoMes;i++) diasFinal.push(porDia[i]||{dia:i,tipo:'fr',label:'Folga',detalhe:'',dhd:false,euroAtlantic:false,voos:[],tripulacao:[],pernoite:null});

    const resumo={voos:0,pernoites:0,folgas:0,sb:0};
    diasFinal.forEach(d=>{
      if(d.tipo==='voo'){resumo.voos+=d.voos.length||1;if(d.pernoite)resumo.pernoites++;}
      else if(['fr','fp','fc','fa'].includes(d.tipo))resumo.folgas++;
      else if(d.tipo==='sb')resumo.sb++;
    });

    return res.status(200).json({content:[{type:'text',text:JSON.stringify({mes:parsed.mes||'Junho 2026',resumo,dias:diasFinal})}]});
  } catch(err) {
    console.error('Parser error:',err);
    return res.status(500).json({error:err.message});
  }
};
module.exports.config={api:{bodyParser:{sizeLimit:'15mb'},maxDuration:120}};

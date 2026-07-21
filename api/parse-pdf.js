module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
if (req.method !== 'POST') return res.status(405).json({success:false,errorCode:'METHOD_NOT_ALLOWED',message:'Método não permitido',details:'',rawText:''});

  const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) return res.status(500).json({success:false,errorCode:'NO_API_KEY',message:'Chave da API não configurada no servidor.',details:'ANTHROPIC_API_KEY ausente nas variáveis de ambiente do Vercel.',rawText:''});

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
  const calcApres=(checkin,dep,intl)=>{const margin=intl?90:50;const computed=subMinutes(dep,margin);const checkinStr=String(checkin||'').trim();if(/^\d{1,2}:\d{2}$/.test(checkinStr)){const parsed=parseTime(checkinStr);if(parsed!=null)return fmtTime(parsed);}return computed;};

  const callClaude = async (content, maxTokens=4000) => {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method:'POST',
      headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
      body: JSON.stringify({model:'claude-sonnet-4-6',max_tokens:maxTokens,messages:[{role:'user',content}]})
    });
    const d = await r.json();
    if (d.error) throw new Error(d.error.message);
    return (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  };

  const PROMPT = `Transcreva esta parte de uma escala de voo da Azul Linhas Aéreas.
Colunas: Activity | Checkin | Start | End | Checkout | Dep | Arr | AcVer | DD/CAT | Crews
- Checkin = apresentação. Start = DECOLAGEM. End = POUSO. São 3 horários DIFERENTES!
- Aeroportos válidos: ${AEROPORTOS.join(',')}
- Se ver "US" = LIS

Formato: DATA_INI | DATA_FIM | ACTIVITY | CHECKIN | START | END | DEP | ARR | ACVER | DDCAT | CREWS
- DATA_INI e DATA_FIM: apenas DD/MM/AAAA (nunca inclua a hora na data)
- CHECKIN/START/END: apenas HH:MM
- CREWS: NOME:FUNCAO por vírgula
Transcreva TODAS as linhas visíveis. Responda só as linhas.`;

 try {
  const {fileData, mediaType, strips} = req.body;
    const temStrips = Array.isArray(strips) && strips.length > 0;
    if (!temStrips && !fileData) {
      return res.status(400).json({success:false,errorCode:'NO_FILE_DATA',message:'Nenhum conteúdo foi enviado.'});
    }
    const tamanhoTotalKB = temStrips ? Math.round(strips.reduce((a,s)=>a+(s?s.length:0),0)/1024) : (fileData?Math.round(fileData.length/1024):0);
    console.log('Import request:', temStrips?`${strips.length} strips`:'sem strips', '· ~'+tamanhoTotalKB+'KB total · fileData incluído:', !!fileData);

    const isImage = (mediaType||'').startsWith('image/');
    let imgB64 = fileData;
    if (!temStrips && !isImage) {
      try {
        const pdf = Buffer.from(fileData,'base64');
        const s = pdf.indexOf(Buffer.from([0xFF,0xD8,0xFF]));
        const e = pdf.lastIndexOf(Buffer.from([0xFF,0xD9]));
        if (s>=0 && e>s) imgB64 = pdf.slice(s,e+2).toString('base64');
      } catch(e) {}
    }

    let stripsArr = [];
    if (temStrips) {
      stripsArr = strips;
      console.log('Strips do navegador:', strips.length, strips.map(s=>Math.round(s.length/1024)+'KB').join(', '));
    } else {
      stripsArr = [imgB64];
      console.log('Sem strips, usando imagem inteira');
    }

    // STEP 1: transcreve cada strip
    const transcricoes = await Promise.all(
      stripsArr.map((s, i) =>
        callClaude([
          {type:'image', source:{type:'base64', media_type:'image/jpeg', data:s}},
          {type:'text', text:PROMPT}
        ], 4000)
        .then(t => { console.log(`Strip ${i+1}: ${t.length} chars`); return t; })
        .catch(e => { console.log(`Strip ${i+1} erro:`, e.message); return ''; })
      )
    );

    const rawText = transcricoes.filter(Boolean).join('\n');
    console.log('Total chars:', rawText.length);

    // STEP 2: converte para JSON
    const jsonText = await callClaude([{type:'text', text:`Converta esta transcrição de escala da Azul em JSON. NÃO calcule nada.

TRANSCRIÇÃO:
${rawText.substring(0,14000)}

CLASSIFICAÇÃO: FR→"fr"; FP/PP→"fp"; FC→"fc"; FA(atividade)→"fa"; SB+nº→"sb"; RHC...→"rea"; SEA→"rea";
ADP→"adp"; ADPOB→"adpob"; AD####/G3###/LA###/JJ###→"voo"; DHD→"voo"+"dhd":true;
Layover→pernoite do dia do voo anterior. NUNCA classifique ADP/ADPOB/FC/FA/SEA como "fr".
Linhas duplicadas → use só uma vez.

POR DIA: {"dia":<dia DATA_INI>,"diaFim":<dia DATA_FIM>,"tipo":"...","dhd":<bool>,
"checkin":"<CHECKIN 1º voo>","ddcat":"<DDCAT>","local":"<DEP só adp/adpob>",
"sbInicio":"<START sb>","sbFim":"<END sb>",
"voos":[{"n":"<ACTIVITY>","o":"<DEP>","d":"<ARR>","dp":"<START>","ar":"<END>","ae":"<ACVER>"}],
"tripulacao":[{"nome":"<NOME>","funcao":"<FUNCAO>"}],
"pernoite":{"l":"<LOCAL>","ci":"<START layover>","co":"<END layover>"}}

Vários voos mesma DATA_INI → 1 objeto. Funções: CA,FO,CL,FA,FE,SUP.
Dias não-voo: voos:[] e tripulacao:[].
Responda APENAS: {"mes":"<Mês AAAA>","dias":[...]}`}], 8000);

    console.log('Step 2 chars:', jsonText.length);

    // Parse JSON
    const extractAndRepair=(t)=>{
      let c=t.replace(/```json\s*/gi,'').replace(/```\s*/gi,'').trim();
      const m=c.match(/\{[\s\S]*\}/);
      if(!m) return null;
      try{return JSON.parse(m[0]);}
      catch(e){
        let x=m[0].replace(/,\s*([}\]])/g,'$1');
        let o=0,oo=0;
        for(let ch of x){if(ch==='[')o++;else if(ch===']')o--;if(ch==='{')oo++;else if(ch==='}')oo--;}
        while(o>0){x+=']';o--;}while(oo>0){x+='}';oo--;}
        try{return JSON.parse(x);}catch(e2){return null;}
      }
    };

    const parsed = extractAndRepair(jsonText);
    if (!parsed||!parsed.dias) {
      console.log('Falha JSON. jsonText amostra:', jsonText.substring(0,300));
      return res.status(500).json({error:'Falha JSON', jsonSample:jsonText.substring(0,500)});
    }

    console.log('Dias parseados:', parsed.dias.length);

    const mesNome=(parsed.mes||'junho 2026').toLowerCase().split(' ')[0];
    const diasNoMes=DIAS_MES[mesNome]||31;
    const labels={fr:'Folga',fp:'Folga Programada',fc:'Folga Casada',fa:'Folga Aniversário',voo:'Voo',rea:'Reserva',sb:'Sobreaviso',adp:'Adaptação',adpob:'Adaptação fora da base'};

    // Normaliza campo dia: converte "08/06/2026" → 8
    parsed.dias = parsed.dias.map(d => {
      if (!d) return d;
      if (typeof d.dia === 'string' && d.dia.includes('/')) {
        d.dia = parseInt(d.dia.split('/')[0]) || 0;
      } else {
        d.dia = parseInt(d.dia) || 0;
      }
      if (typeof d.diaFim === 'string' && d.diaFim.includes('/')) {
        d.diaFim = parseInt(d.diaFim.split('/')[0]) || d.dia;
      } else {
        d.diaFim = parseInt(d.diaFim) || d.dia;
      }
      return d;
    });
   parsed.dias=parsed.dias.filter(d=>d&&d.dia>=1&&d.dia<=diasNoMes);
    // ── RECUPERAÇÃO DETERMINÍSTICA DE VOOS A PARTIR DO rawText ──────────────
    const REGEX_VOO_RAW=/^(AD|G3|LA|JJ)\d+$/i;
    const REGEX_DATA_CAMPO=/^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
    const REGEX_HORA_CAMPO=/^\d{1,2}:\d{2}$/;
    const campoOperacionalValido=(v)=>{
      if(!v)return false;
      const s=String(v).trim();
      if(!s||s==='--')return false;
      if(REGEX_DATA_CAMPO.test(s))return false;
      return true;
    };
    const pontuarCandidato=(cand)=>['checkin','start','end','dep','arr','acver'].filter(k=>campoOperacionalValido(cand[k])).length;
    const possuiHorarioOperacional=(cand)=>REGEX_HORA_CAMPO.test(cand.checkin||'')||REGEX_HORA_CAMPO.test(cand.start||'')||REGEX_HORA_CAMPO.test(cand.end||'');

    const candidatos=[];
    rawText.split('\n').forEach(linha=>{
      const c=linha.split('|').map(x=>x.trim());
      if(c.length<9)return;
      const[dataIni,,activity,checkin,start,end,dep,arr,acver]=c;
      if(!REGEX_VOO_RAW.test(activity||''))return;
      const diaM=(dataIni||'').match(/^(\d{1,2})\//);
      if(!diaM)return;
      const dia=parseInt(diaM[1],10);
      if(dia<1||dia>diasNoMes)return;
      candidatos.push({dia,n:activity.toUpperCase().trim(),checkin,start,end,dep,arr,acver});
    });

    const candidatosFiltrados=[];
    candidatos.forEach(cand=>{
      const idx=candidatosFiltrados.findIndex(o=>o.n===cand.n&&Math.abs(o.dia-cand.dia)<=1);
      if(idx===-1){candidatosFiltrados.push(cand);return;}
      const outro=candidatosFiltrados[idx];
      if(outro.dia===cand.dia){
        if(pontuarCandidato(cand)>pontuarCandidato(outro))candidatosFiltrados[idx]=cand;
        return;
      }
      const candTemHora=possuiHorarioOperacional(cand);
      const outroTemHora=possuiHorarioOperacional(outro);
      if(candTemHora&&outroTemHora){candidatosFiltrados.push(cand);return;}
      if(!candTemHora&&outroTemHora)return;
      if(candTemHora&&!outroTemHora){candidatosFiltrados[idx]=cand;return;}
      if(pontuarCandidato(cand)>pontuarCandidato(outro))candidatosFiltrados[idx]=cand;
    });

    candidatosFiltrados.forEach(cand=>{
      const checkinValido=REGEX_HORA_CAMPO.test(cand.checkin||'')?cand.checkin:'';
      const dpVal=campoOperacionalValido(cand.start)?cand.start:'';
      const arVal=campoOperacionalValido(cand.end)?cand.end:'';
      const oVal=campoOperacionalValido(cand.dep)?cand.dep:'';
      const dVal=campoOperacionalValido(cand.arr)?cand.arr:'';
      const aeVal=campoOperacionalValido(cand.acver)?cand.acver:'';
      const existente=parsed.dias.find(d=>d&&d.dia===cand.dia&&Array.isArray(d.voos)&&d.voos.some(v=>(v.n||'').toUpperCase().trim()===cand.n));
      if(existente){
        const vooExistente=existente.voos.find(v=>(v.n||'').toUpperCase().trim()===cand.n);
        if(!existente.checkin&&checkinValido){existente.checkin=checkinValido;}
        if(vooExistente){
          if((!vooExistente.o||vooExistente.o==='--')&&oVal)vooExistente.o=oVal;
          if((!vooExistente.d||vooExistente.d==='--')&&dVal)vooExistente.d=dVal;
          if((!vooExistente.dp||vooExistente.dp==='--')&&dpVal)vooExistente.dp=dpVal;
          if((!vooExistente.ar||vooExistente.ar==='--')&&arVal)vooExistente.ar=arVal;
          if((!vooExistente.ae||vooExistente.ae==='--')&&aeVal)vooExistente.ae=aeVal;
        }
        return;
      }
      parsed.dias.push({dia:cand.dia,diaFim:cand.dia,tipo:'voo',dhd:false,checkin:checkinValido,ddcat:'',local:'',
        voos:[{n:cand.n,o:oVal,d:dVal,dp:dpVal,ar:arVal,ae:aeVal}],
        tripulacao:[],pernoite:null});
    });
    const CODIGO_RE=[
      [/^(SEA|RHC)/,'rea'],
      [/^FR\b/,'fr'],
      [/^(FP|PP)\b/,'fp'],
      [/^FC\b/,'fc'],
      [/^FA\b/,'fa'],
      [/^SB\d/,'sb'],
      [/^ADPOB\b/,'adpob'],
      [/^ADP\b/,'adp'],
      [/^(AD|G3|LA|JJ)\d/,'voo']
    ];
   parsed.dias.forEach(d=>{
      const cod=((Array.isArray(d.voos)&&d.voos[0]&&d.voos[0].n)||d.tipo||'').toUpperCase().trim();
      for(const[re,t]of CODIGO_RE){if(re.test(cod)){d.tipo=t;break;}}
      if(d.tipo!=='voo'){d.voos=[];d.tripulacao=[];}
    });
    const vistosFolga=new Set();
    parsed.dias=parsed.dias.filter(d=>{
      if(d.tipo==='fr'||d.tipo==='fp'){
        const chave=d.dia+'-'+d.tipo;
        if(vistosFolga.has(chave))return false;
        vistosFolga.add(chave);
      }
      return true;
    });
    const contarCamposValidos=(v)=>['o','d','dp','ar','ae'].filter(k=>v&&v[k]&&v[k]!=='--').length;
    const dedupVoos=(arr)=>{
      const porNumero={};
      arr.forEach(v=>{
        const n=(v.n||'').toUpperCase().trim();
        if(!porNumero[n]||contarCamposValidos(v)>contarCamposValidos(porNumero[n]))porNumero[n]=v;
      });
      return Object.values(porNumero);
    };
    parsed.dias.forEach(d=>{
      d.voos=Array.isArray(d.voos)?d.voos:[];
      d.tripulacao=Array.isArray(d.tripulacao)?d.tripulacao:[];
      d.pernoite=d.pernoite&&d.pernoite.l?d.pernoite:null;
    d.dhd=d.dhd===true;d.detalhe=d.detalhe||'';
      if(d.checkin&&/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(String(d.checkin).trim()))d.checkin='';
      const ddcat=(d.ddcat||'').toUpperCase();
      d.euroAtlantic=ddcat==='COBS'||ddcat==='V';
     if(d.tipo==='voo'&&d.voos.length>0){
        d.voos=dedupVoos(d.voos);
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
    parsed.dias.forEach(d=>{
      const atual=porDia[d.dia];
      if(!atual){porDia[d.dia]=d;return;}
      if(atual.tipo==='voo'&&d.tipo==='voo'){
        atual.voos = dedupVoos([
          ...(atual.voos || []),
          ...(d.voos || [])
        ]);

        atual.tripulacao =
          (d.tripulacao || []).length > (atual.tripulacao || []).length
            ? d.tripulacao
            : atual.tripulacao;

        atual.checkin = atual.checkin || d.checkin || '';
        atual.pernoite = atual.pernoite || d.pernoite || null;
        atual.ddcat = atual.ddcat || d.ddcat || '';
        atual.euroAtlantic = atual.euroAtlantic || d.euroAtlantic;

        const first = atual.voos[0];
        if(first){
          const intl =
            atual.voos.some(v => isIntl(v.o) || isIntl(v.d)) ||
            atual.euroAtlantic;

          atual.apres = calcApres(
            atual.checkin,
            first.dp,
            intl
          );
          atual.apresLocal = first.o;
        }

        return;
      }
      if(atual.tipo!=='voo'&&d.tipo==='voo'){
        d.atividadeAnterior=atual.label||atual.tipo;
        porDia[d.dia]=d;
        return;
      }
      if(atual.tipo!=='voo'&&d.tipo!=='voo'){
        porDia[d.dia]=d;
      }
    });

    // ── RECUPERAÇÃO DE ATIVIDADE ANTERIOR (SEA/RHC/SB) A PARTIR DO rawText ──
    const REGEX_ANTERIOR_RAW=/^(SEA|RHC\w*|SB\d+)/i;
    const candidatosAnteriores=[];
    rawText.split('\n').forEach(linha=>{
      const c=linha.split('|').map(x=>x.trim());
      if(c.length<8)return;
      const[dataIni,,activity,,start,end,dep]=c;
      const codigo=(activity||'').toUpperCase().trim();
      const m=codigo.match(REGEX_ANTERIOR_RAW);
      if(!m)return;
      const diaM=(dataIni||'').match(/^(\d{1,2})\//);
      if(!diaM)return;
      const dia=parseInt(diaM[1],10);
      const ehSB=/^SB\d+/.test(codigo);
      candidatosAnteriores.push({
        dia,codigo,
        tipo:ehSB?'sb':'rea',
        label:ehSB?'Sobreaviso':'Reserva',
        inicio:REGEX_HORA_CAMPO.test(start||'')?start:'',
        fim:REGEX_HORA_CAMPO.test(end||'')?end:'',
        local:dep||''
      });
    });
    Object.values(porDia).forEach(d=>{
      if(d.tipo!=='voo')return;
      const cand=candidatosAnteriores.find(c=>c.dia===d.dia);
      if(!cand)return;
      const atual=(d.atividadeAnterior&&typeof d.atividadeAnterior==='object')?d.atividadeAnterior:{};
     d.atividadeAnterior={
        tipo:atual.tipo||cand.tipo,
        label:atual.label||cand.label,
        codigo:atual.codigo||cand.codigo,
        inicio:atual.inicio||cand.inicio,
        fim:atual.fim||cand.fim,
        local:atual.local||cand.local
      };
    });

    // ── VALIDAÇÃO FINAL DE APRESENTAÇÃO (checkin confundido com partida) ────
    Object.values(porDia).forEach(d=>{
      if(d.tipo!=='voo'||!Array.isArray(d.voos)||d.voos.length===0)return;
      const first=d.voos[0];
      if(!d.apres||d.apres!==first.dp)return;
      let checkinRecuperado='';
      rawText.split('\n').forEach(linha=>{
        if(checkinRecuperado)return;
        const c=linha.split('|').map(x=>x.trim());
        if(c.length<9)return;
        const[dataIni,,activity,checkin]=c;
        const diaM=(dataIni||'').match(/^(\d{1,2})\//);
        if(!diaM)return;
        if(parseInt(diaM[1],10)!==d.dia)return;
        if((activity||'').toUpperCase().trim()!==(first.n||'').toUpperCase().trim())return;
        if(REGEX_HORA_CAMPO.test(checkin||'')&&checkin!==first.dp)checkinRecuperado=checkin;
      });
      if(checkinRecuperado){
        d.apres=checkinRecuperado;
      } else {
        const intl=d.voos.some(v=>isIntl(v.o)||isIntl(v.d))||d.euroAtlantic;
        d.apresSugerida=calcApres('',first.dp,intl);
        d.apres=null;
        d.precisaRevisao=true;
        d.motivoRevisao='Apresentação não confirmada';
      }
    });

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

   const diasFinal = [];
    for (let i = 1; i <= diasNoMes; i++) {
      diasFinal.push(
        porDia[i] || {
          dia: i,
          tipo: 'pendente',
          label: 'Revisar',
          detalhe: 'Atividade não identificada com segurança.',
          dhd: false,
          euroAtlantic: false,
          voos: [],
          tripulacao: [],
          pernoite: null,
          precisaRevisao: true
        }
      );
    }

    const resumo={voos:0,pernoites:0,folgas:0,sb:0};
    diasFinal.forEach(d=>{
      if(d.tipo==='voo'){resumo.voos+=d.voos.length||1;if(d.pernoite)resumo.pernoites++;}
      else if(['fr','fp','fc','fa'].includes(d.tipo))resumo.folgas++;
      else if(d.tipo==='sb')resumo.sb++;
    });

    console.log('Resumo:', JSON.stringify(resumo));
    return res.status(200).json({content:[{type:'text',text:JSON.stringify({mes:parsed.mes||'Junho 2026',resumo,dias:diasFinal})}], rawText: rawText.substring(0,8000)});

 } catch(err) {
    console.error('Parser error:', err.message);
    return res.status(500).json({success:false,errorCode:'PARSER_ERROR',message:'Erro interno ao processar a escala.',details:err.message||'Erro desconhecido',rawText:''});
  }
};
module.exports.config = {
  api: {
    bodyParser: {
      sizeLimit: '50mb'
    }
  },
  maxDuration: 120
};

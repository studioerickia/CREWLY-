async function processarPDF(){
  if(!arq)return;
  showEst('proc');
  await dl(500);
  setS(2,'ok','Arquivo recebido ✓');setS(3,'ld','Crewly preparando imagem...');
  const b64=await toB64(arq);
  const isImg=arq.type.startsWith('image/');
  const mt=isImg?arq.type:'application/pdf';
  try{
    // Corta a imagem em 3 strips no navegador antes de enviar
    const strips = await cortarImagemEmStrips(b64, mt);
    await dl(500);setS(3,'ok','Crewly organizou voos e folgas ✓');setS(4,'ld','Crewly calculando horas...');
    const body = {fileData:b64, mediaType:mt};
    if(strips) body.strips = strips;
    const r=await fetch('/api/parse-pdf',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify(body)
    });
    // Lê como texto primeiro — evita crash quando Vercel retorna HTML de erro
    const rawResp = await r.text();
    await dl(600);setS(4,'ok','Crewly calculou horas e diárias ✓');await dl(400);
    let data = {};
    try { data = JSON.parse(rawResp); } catch(jsonErr) {
      // Resposta não era JSON (HTML do Vercel, timeout, etc.)
      mostrarErroImport(
        'Servidor demorou ou retornou resposta inválida.',
        'HTTP '+r.status+' · Resposta não-JSON: '+rawResp.substring(0,300),
        ''
      );
      return;
    }
    const rawTextDetectado = data.rawText || '';
    // Erro estruturado vindo do backend
    if(data.success===false || data.error || data.errorCode){
      mostrarErroImport(
        data.message || data.error || 'Erro ao processar escala.',
        data.details || data.errorCode || '',
        rawTextDetectado
      );
      return;
    }
    let txt=(data.content&&data.content[0]?data.content[0].text:'').replace(/```json|```/g,'').trim();
    let res;
    try{res=JSON.parse(txt);}catch(e){const m=txt.match(/\{[\s\S]*\}/);if(m)try{res=JSON.parse(m[0]);}catch(e2){}}
    if(!res||!res.dias||res.dias.length===0){
      showEst('err');
      const em=document.getElementById('emsg');
      if(em)em.innerHTML='Crewly não encontrou dias na escala.<br><small style="opacity:.7">Tente novamente ou preencha manualmente.</small>';
      const eb=document.getElementById('err-raw-box');
      if(eb&&rawTextDetectado){eb.style.display='block';document.getElementById('err-raw-txt').textContent=rawTextDetectado;}
      return;
    }
    showRes(res, rawTextDetectado);
  }catch(e){
    console.error('Erro parser:',e);
    mostrarErroImport('Erro inesperado ao processar.', e.message, '');
  }
}

async function cortarImagemEmStrips(b64, mediaType) {
  return new Promise((resolve) => {
    try {
      const byteStr = atob(b64);
      const arr = new Uint8Array(byteStr.length);
      for(let i=0;i<byteStr.length;i++) arr[i]=byteStr.charCodeAt(i);
      let imgBytes = arr;
      if(mediaType === 'application/pdf') {
        let start=-1;
        for(let i=0;i<arr.length-2;i++){if(arr[i]===0xFF&&arr[i+1]===0xD8&&arr[i+2]===0xFF){start=i;break;}}
        let end=-1;
        for(let i=arr.length-2;i>=0;i--){if(arr[i]===0xFF&&arr[i+1]===0xD9){end=i;break;}}
        if(start>=0&&end>start) imgBytes=arr.slice(start,end+2);
        else{resolve(null);return;}
      }
      const blob = new Blob([imgBytes],{type:'image/jpeg'});
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const W=img.width, H=img.height;
   const N=3, stripH=Math.ceil(H/N), overlap=60;
const scaleW = W > 1200 ? 1200/W : 1;
        const strips=[];
        for(let i=0;i<N;i++){
          const y1=Math.max(0,i*stripH-(i>0?overlap:0));
          const y2=Math.min(H,(i+1)*stripH+overlap);
          const scaleW = W > 1000 ? 1000/W : 1;
          const canvas=document.createElement('canvas');
          canvas.width=Math.round(W*scaleW);canvas.height=Math.round((y2-y1)*scaleW);
          const ctx=canvas.getContext('2d');
          ctx.drawImage(img,0,y1,W,y2-y1,0,0,canvas.width,canvas.height);
          strips.push(canvas.toDataURL('image/jpeg',0.35).split(',')[1]);
        }
        URL.revokeObjectURL(url);
        console.log('Strips cortadas:',strips.map(s=>Math.round(s.length/1024)+'KB'));
        resolve(strips);
      };
      img.onerror=()=>{URL.revokeObjectURL(url);resolve(null);};
      img.src=url;
    }catch(e){console.log('Erro ao cortar:',e);resolve(null);}
  });
}

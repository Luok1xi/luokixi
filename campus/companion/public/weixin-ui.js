export function initWeixin({api,notify}){
  const $=id=>document.getElementById(id);let login=null,verifyCode,stopped=false;
  const show=info=>{$('weixin-state').textContent=info.status+(info.account?' · '+info.account:'')+(info.pending?` · ${info.pending} 条等待发送`:'');$('weixin-test').disabled=!info.ready;$('weixin-disconnect').disabled=!info.paired&&!login;};
  const refresh=async()=>{try{const info=await api('/api/weixin/status');show(info);if(!login&&info.login){login=info.login;$('weixin-qr-image').src=login.image;$('weixin-qr').hidden=false;void poll(login);}}catch{/* Main app displays lost connection. */}};
  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function poll(current){while(login===current&&!stopped){try{
    const code=verifyCode;verifyCode=undefined;const info=await api('/api/weixin/poll',{id:current.id,...(code?{verifyCode:code}:{})});
    if(login!==current)return;show(info);
    $('weixin-verify').hidden=info.loginStatus!=='need_verifycode';
    if(info.paired&&!info.loginStatus){$('weixin-qr').hidden=true;login=null;notify('微信授权已保存。现在从手机给 她 发一条文字消息。');break;}
    if(['expired','verify_code_blocked'].includes(info.loginStatus)||!info.loginStatus){login=null;$('weixin-login-tip').textContent=info.status;break;}
    await wait(info.loginStatus==='need_verifycode'?2500:1500);
  }catch(e){if(login!==current)return;$('weixin-login-tip').textContent=e.message;if(Date.now()>current.expires){login=null;break;}await wait(4000);}}
  }
  $('weixin-login').onclick=async()=>{const b=$('weixin-login');b.disabled=true;login=null;verifyCode=undefined;try{
    const current=await api('/api/weixin/login',{});login=current;$('weixin-qr-image').src=current.image;$('weixin-qr').hidden=false;$('weixin-verify').hidden=true;$('weixin-login-tip').textContent=current.message+'；二维码约五分钟有效。';void poll(current);
  }catch(e){notify(e.message,true);}finally{b.disabled=false;}};
  $('weixin-verify').onsubmit=e=>{e.preventDefault();verifyCode=$('weixin-code').value.trim();$('weixin-code').value='';$('weixin-login-tip').textContent='正在提交手机配对验证码…';};
  $('weixin-test').onclick=async()=>{try{notify((await api('/api/weixin/test',{})).message);await refresh();}catch(e){notify(e.message,true);}};
  $('weixin-disconnect').onclick=async()=>{login=null;verifyCode=undefined;$('weixin-qr').hidden=true;try{notify((await api('/api/weixin/disconnect',{})).message);await refresh();}catch(e){notify(e.message,true);}};
  void refresh();const timer=setInterval(()=>{if(!document.hidden)void refresh();},5000);addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);});
}

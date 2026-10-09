// Speech-only normalization, matching Shinsekai's remove_parentheses behavior.
// The displayed dialogue and remembered message are never modified here.
// Reference: RachelForster/Shinsekai b39c8cef, ai/llm/text_processor.py.
export function spokenText(text){
  return String(text||'').replace(/\n*参考来源：[\s\S]*$/,'')
    .replace(/\[表情包：[^\]]*\]/g,'').replace(/https?:\/\/\S+/g,'')
    .replace(/\([^()]*\)/g,'').replace(/（[^（）]*）/g,'')
    .replace(/\*[^*]*\*/gs,'').replace(/<\/?[a-z][^>]*>/gi,'')
    .replace(/\s+/g,' ').trim();
}

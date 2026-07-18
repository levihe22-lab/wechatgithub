const encoder=new TextEncoder();
export function makeAad(packageId,resourceId){const aad=new Uint8Array(36);aad.set(encoder.encode('WCV3'),0);aad.set(packageId,4);aad.set(resourceId,20);return aad;}
export function makeWcv2Aad(packageId,recordIndex){return encoder.encode(`WCV2:${packageId}:${recordIndex}`);}
export async function deriveSessionKey(password,salt,iterations=600000){
 const passwordBytes=encoder.encode(password);try{const material=await crypto.subtle.importKey('raw',passwordBytes,'PBKDF2',false,['deriveKey']);return await crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',salt,iterations},material,{name:'AES-GCM',length:256},false,['decrypt']);}catch{throw new Error('E_AUTH');}finally{passwordBytes.fill(0);}
}
export async function decryptFrame(key,header,resourceId,frame){try{const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:frame.iv,additionalData:makeAad(header.packageId,resourceId),tagLength:128},key,frame.ciphertext);return new Uint8Array(clear);}catch{throw new Error('E_AUTH');}}
export async function decryptWcv2Frame(key,packageId,recordIndex,frame){try{const clear=await crypto.subtle.decrypt({name:'AES-GCM',iv:frame.iv,additionalData:makeWcv2Aad(packageId,recordIndex),tagLength:128},key,frame.ciphertext);return new Uint8Array(clear);}catch{throw new Error('E_AUTH');}}
export async function decryptManifest(reader,header,key){const frame=await reader.readFrame(header.manifestOffset,header.manifestLength);const clear=await decryptFrame(key,header,header.manifestResourceId,frame);try{return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(clear));}catch{throw new Error('E_FORMAT');}finally{clear.fill(0);}}

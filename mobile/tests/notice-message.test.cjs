const test=require('node:test'),assert=require('node:assert/strict');
const {noticeMessage,hostSettingsNotice}=require('./control-fixture.cjs').load('lib/notice-message.ts');
test('unexpected technical errors never appear in user-facing notices',()=>{
 for(const value of [new Error('EIO /private/photo.jpg token=secret'),null,{message:'secret'},'HTTP 500: large stack trace'])assert.equal(noticeMessage(value,'No se pudo enviar.'),'No se pudo enviar.');
 assert.equal(hostSettingsNotice({code:'write-failed',message:'/private/settings: EIO'}),'No se pudo guardar la lista de equipos.');
 assert.equal(hostSettingsNotice(new Error('secret')),'No se pudo actualizar la lista de equipos.');
});
test('known permission, selection and session failures retain a brief actionable explanation',()=>{
 assert.equal(noticeMessage('camera permission denied','Fallback'),'Habilitá Cámara en Configuración.');
 assert.equal(noticeMessage('Elegí hasta 10 fotos.','Fallback'),'Elegí hasta 10 fotos.');
 assert.equal(noticeMessage('supera el tamaño máximo','Fallback'),'La selección supera el tamaño permitido.');
 assert.equal(noticeMessage('session changed: epoch=secret','Fallback'),'Conexión cambiada. Revisá el envío.');
 assert.equal(hostSettingsNotice({code:'duplicate-origin'}),'Ese equipo ya está guardado.');
});

import { importLib } from './tests/_compile.mjs';
const m = await importLib('sharedSchema');
console.log(Object.keys(m).slice(0,20));
console.log(JSON.stringify(m.renderSharedNode({id:'a',kind:'Transfer',queue:'q'},'chat')));

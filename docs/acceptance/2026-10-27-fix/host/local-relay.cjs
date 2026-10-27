// Loopback-only TCP relay to the isolated test container; supports WebSocket too.
const net=require('node:net'),{spawn}=require('node:child_process');
net.createServer(client=>{
 const child=spawn('docker',['exec','-i','companion-host-browser-20261027','node','-e',`const s=require('net').connect(18888,require('os').networkInterfaces().eth0[0].address);process.stdin.pipe(s);s.pipe(process.stdout);s.on('error',()=>process.exit(1));`],{stdio:['pipe','pipe','pipe'],windowsHide:true});
 client.pipe(child.stdin);child.stdout.pipe(client);client.on('error',()=>child.kill());client.on('close',()=>child.kill());child.on('close',()=>client.destroy());child.stderr.resume();child.stdin.on('error',()=>{});
}).listen(18890,'127.0.0.1',()=>console.log('isolated DSH relay 127.0.0.1:18890'));

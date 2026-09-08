console.log("🚀 Initializing Cloudflare login flow via Chrome Suhara...");

const proc = Bun.spawn(["npx.cmd", "wrangler", "login"], {
  stdout: "pipe",
  stderr: "inherit",
});

let opened = false;
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();

async function readStream() {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value);
    process.stdout.write(text);

    const match = text.match(/https:\/\/dash\.cloudflare\.com\/oauth2\/auth\S+/);
    if (match && !opened) {
      opened = true;
      const url = match[0];
      console.log("\n⚡ Automatically opening authentication link on Chrome Profile Suhara...");
      Bun.spawn([
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "--profile-directory=Profile 2",
        url,
      ]);
    }
  }
}

readStream().then(async () => {
  const code = await proc.exited;
  if (code === 0) {
    console.log("\n🎉 LOGIN SUCCESSFUL! Cloudflare has been authenticated on your machine.");
  } else {
    console.log(`\n❌ Process exited with code: ${code}`);
  }
  process.exit(code);
});

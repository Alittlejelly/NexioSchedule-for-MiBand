/**
 * 在 RPK 根目录注入 rpk_info.json，并用 aiot 内置 debug 证书重新签名
 */
const fs = require('fs')
const path = require('path')
const os = require('os')

const root = __dirname
const rpkPath = process.argv[2]
if (!rpkPath) {
  console.error('usage: node sign-rpk.js <path-to.rpk>')
  process.exit(1)
}

const toolkitRoot = path.join(root, 'node_modules', '@aiot-toolkit', 'packager')
const { signForRpk } = require(path.join(toolkitRoot, 'lib', 'signature', 'exports.js'))
const ziputil = require(path.join(toolkitRoot, 'lib', 'common', 'ziputil.js'))
const pemDir = path.join(toolkitRoot, 'lib', 'signature', 'pem')

async function main() {
  const info = {
    package: 'com.haooz.chedule',
    name: 'nexio课程表',
    versionName: '1.0.0',
    versionCode: 17,
    icon: '/common/icon.png'
  }

  const raw = fs.readFileSync(rpkPath)
  const fileListObj = await ziputil.createFileListFromZipBuffer(raw)
  const files = []
  let hasInfo = false
  for (const f of fileListObj.fileList) {
    if (f.path === 'rpk_info.json') {
      hasInfo = true
      files.push({ path: f.path, content: Buffer.from(JSON.stringify(info)) })
    } else {
      files.push(f)
    }
  }
  if (!hasInfo) {
    files.push({ path: 'rpk_info.json', content: Buffer.from(JSON.stringify(info)) })
  }

  const unsigned = await ziputil.createZipBufferFromFileList(files, fileListObj.comment)
  const privatekey = fs.readFileSync(path.join(pemDir, 'private.pem'))
  const certificate = fs.readFileSync(path.join(pemDir, 'certificate.pem'))
  const signed = await signForRpk(unsigned, privatekey, certificate)

  fs.writeFileSync(rpkPath, signed)
  console.log('signed', rpkPath, signed.length)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})

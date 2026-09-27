import webpush from 'web-push'
const keys = webpush.generateVAPIDKeys()
console.log('VITE_VAPID_PUBLIC_KEY=' + keys.publicKey)
console.log('WEB_PUSH_VAPID_PUBLIC_KEY=' + keys.publicKey)
console.log('WEB_PUSH_VAPID_PRIVATE_KEY=' + keys.privateKey)
console.log('WEB_PUSH_SUBJECT=mailto:replace-with-your-email@example.com')

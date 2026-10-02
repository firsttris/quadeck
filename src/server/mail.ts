// E-mail over SMTP (nodemailer): implicit TLS (465), STARTTLS (587, required –
// never falls back to plain text when a password is set) or plain for a relay
// on the local network.

import nodemailer from 'nodemailer'
import type { Channel } from '~/shared/notify'

export type Mail = (c: Channel, m: { from: string; to: string[]; subject: string; text: string }) => Promise<void>

export const sendMail: Mail = async (c, m) => {
  const transport = nodemailer.createTransport({
    host: c.host,
    port: c.port,
    secure: c.security === 'tls',
    requireTLS: c.security === 'starttls',
    ignoreTLS: c.security === 'none',
    auth: c.user ? { user: c.user, pass: c.token ?? '' } : undefined,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  })
  try {
    await transport.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, headers: { 'X-Mailer': 'Quadeck' } })
  } catch (e) {
    throw new Error(smtpError(e as Error & { code?: string; responseCode?: number; response?: string }))
  } finally {
    transport.close()
  }
}

/** nodemailer's errors in plain words, with what usually helps. */
export function smtpError(e: { message: string; code?: string; responseCode?: number; response?: string }): string {
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534)
    return `Anmeldung abgelehnt (${(e.response ?? e.message).trim().slice(0, 160)}) – Benutzer und Passwort prüfen; viele Anbieter brauchen ein App-Passwort`
  if (e.code === 'ECONNREFUSED') return 'Verbindung abgelehnt – Server und Port prüfen'
  if (e.code === 'ETIMEDOUT' || e.code === 'ECONNECTION') return `Keine Verbindung zum SMTP-Server (${e.message}) – Port, Verschlüsselung oder Firewall prüfen`
  if (e.code === 'EDNS') return 'SMTP-Server nicht gefunden – Name prüfen'
  if (e.code === 'ESOCKET' && /wrong version number|ssl3_get_record|packet length/i.test(e.message)) return 'TLS passt nicht – bei Port 465 „SSL/TLS“, bei 587 „STARTTLS“ wählen'
  if (e.responseCode && e.responseCode >= 500) return `Server lehnt ab: ${(e.response ?? e.message).trim().slice(0, 200)}`
  return e.message
}

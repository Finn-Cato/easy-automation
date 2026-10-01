# Opphav og gjenbruk

Light Guard bygger videre på Easy Automation fra Finn Cato Andersen:
https://github.com/Finn-Cato/easy-automation, med funksjoner og grensesnittarbeid
fra Solviks videreutvikling:
https://github.com/5olvik/easy-automation. Appen beholder teknisk ID
`no.easy.automation` for å oppdatere den eksisterende lokale testinstallasjonen.

Grensesnittet bygger videre på originalens innstillingsside. Den nye filen
`settings/style.css` tilpasser fargetokens, toppseksjon, kort og navigasjonsmønster
fra House Guard, som igjen bygger på Power Guard 0.8.158. Kildeprosjekter:
https://github.com/5olvik/house-guard og https://github.com/Finn-Cato/power-guard.
Oppgitt forfatter for Power Guard: Power Guard, powerguard@finnlyden.no.

Den gjenbrukte og tilpassede stilfilen distribueres under GPL-3.0-only.
Full lisenstekst for denne delen står i `LICENSE.ui.txt`. Opphavsmerking fra de
gjenbrukte delene er beholdt. Dette angir ikke en ny lisens for originalens øvrige kode.

Romoversikten kobler det nye grensesnittet til eksisterende automasjoner,
enhetscache, pauser og hendelser. Den viser ingen egne oppdiktede lysstatuser.

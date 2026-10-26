# FairBuy

**Scegliere l’acquisto migliore, non solo il prezzo più basso.**

FairBuy è una proposta di shopping assistant personale: confronta alternative fattibili considerando costo totale, compatibilità e adeguatezza alle preferenze. Distingue i fatti verificati dalle dichiarazioni dei venditori, mostra fonti e incertezze e lascia all’utente la decisione finale.

> **Stato:** concept e documentazione; non è un’applicazione funzionante e non presenta offerte attuali. I numeri d’esempio sono sintetici. Nessun acquisto, contatto con venditori o prenotazione viene effettuato.

## MVP proposto

Un confronto circoscritto di elettronica nuova e usata in una sola città, a partire da URL o screenshot forniti dall’utente. Estrazione strutturata (con visione Meta solo dopo averne verificato l’accesso), specifiche normalizzate, filtro di fattibilità e graduatoria deterministica spiegabile. Un connettore live legittimo, se davvero disponibile; altrimenti fixture chiaramente etichettate.

La proposta completa include flussi, architettura, schema, sicurezza, demo di tre minuti, tabella comparativa sintetica, criteri di accettazione, casi avversari e piano di dieci giorni: [leggi la proposta](docs/PROPOSAL.md).

## Principi

- **Fattibilità prima del punteggio:** vincoli rigidi (compatibilità, budget massimo, orari) escludono le opzioni non praticabili.
- **Costo totale e adeguatezza:** prezzo consegnato, oneri applicabili, garanzia, resi, supporto e costi/rischi pertinenti.
- **Provenienza visibile:** fonte, ora di acquisizione, disponibilità, valuta, livello di confidenza e dati mancanti.
- **AI assistiva, non autoritaria:** il modello estrae e chiarisce; regole deterministiche filtrano e ordinano. L’utente può correggere i dati.
- **Nessuna azione irreversibile:** niente checkout, messaggi ai venditori o prenotazioni automatiche.

## Orizzonte del prodotto

Oltre all’MVP, la visione comprende beni nuovi, usati, voli porta-a-porta e consegna di cibo. Sono verticali futuri, non integrazioni promesse. Per i voli si escludono prima le partenze incompatibili con i vincoli; per il cibo si confronta lo stesso carrello e si rispettano copertura e promozioni effettivamente disponibili. Dettagli e limiti sono nella [proposta](docs/PROPOSAL.md#2-verticali-del-prodotto).

## Documentazione e pubblicazione

README e `docs/` sono la fonte di verità: versionabili, leggibili fuori da GitHub e revisionabili via pull request; in futuro il codice può convivere nello stesso repository. La Wiki è separata dalla cronologia del repository e offre un flusso di revisione meno naturale; disponibilità per repository privati dipendente dal piano. I Projects dell’organizzazione sono viste di pianificazione, non documentazione. Pages, Discussions, Issues/Projects e profilo organizzativo possono essere valutati in seguito, senza creare automaticamente siti, wiki o board. Vedi [scelte di documentazione](docs/PROPOSAL.md#12-documentazione-su-github).

## Hackathon Meta

Il tema “Build for Your World” è coerente con un assistente che traduce vincoli quotidiani in scelte comprensibili. Modelli, crediti partner, scadenza e verifiche richieste sono riportati con fonti e riserve nella [sezione hackathon](docs/PROPOSAL.md#10-meta-hackathon-e-fornitori-di-inferenza). Partecipazione e idoneità del team non sono date per scontate.

## Stato e contributi

Questo repository contiene soltanto documentazione di progetto; non è un impegno di rilascio. Prima di implementare occorre validare accesso ai dati, condizioni d’uso, account/modelli, privacy, regole dell’evento e fattibilità del connettore. Non inserire credenziali, dati personali o offerte non verificate.

# Sistema di Visione AI per la Domotica

Tramite l’uso di una telecamera, questa incredibile intelligenza artificiale è in grado di controllare la domotica. L’AI capisce le vostre intenzioni: vi vede alla scrivania a lavorare? Vi accende le luci della scrivania. Vi vede a letto a dormire? Spegne tutte le luci. Vi vede con l’accappatoio in mano? Decide di accendere le luci del bagno e mettere un po’ di musica.

Il processo di configurazione è semplice, e aggiungere nuovi tipi di dispositivi è facilissimo: iniziare a usarla richiede davvero pochissimo.

Ma come lavora questo “occhio”? In generale, un’intelligenza artificiale proprietaria (basata su BLIP di Salesforce) è in grado di descrivere cosa sta facendo l’utente: prima a livello generale, indicando dove si trova nella stanza e con chi, poi in modo più preciso, riuscendo a dire quali oggetti ha in mano e in cosa è impegnato.

Successivamente, un algoritmo proprietario è in grado – partendo da questa descrizione – di eseguire le azioni necessarie. Si basa sulla comprensione del linguaggio naturale (NLU): a partire da una descrizione iniziale, è capace di generare e concatenare azioni pertinenti fino a ricevere un segnale di stop, in modo simile alla generazione autoregressiva dei modelli di linguaggio di grandi dimensioni (LLM).

In caso di richieste più complesse o inserite direttamente dall’utente, entra in gioco un assistente OpenAI che, grazie all’arte del “prompt engineering”, riesce a gestire le azioni più difficili da interpretare (per esempio, quando l’utente chiede qualcosa di specifico tramite l’app).

Questo ultimo aspetto potrebbe far sorgere dubbi sulla privacy: in realtà, non c’è nessun problema, perché all’assistente viene inviata solo la descrizione di ciò che sta accadendo nella stanza, nulla di più.

L’idea, nel tempo, è di eliminare completamente anche questo supporto esterno, man mano che l’algoritmo proprietario diventa sempre più capace.

Già dall’inizio del progetto, però, l’assistente OpenAI è stato eliminato per la maggior parte dei task: inizialmente veniva utilizzato per tutto, ma questo rendeva il sistema lento. Oggi interviene solo quando strettamente necessario.


# AI-based Smart Home Vision System

Through the use of a camera, this incredible artificial intelligence is able to control home automation. The AI understands your intentions: it sees you working at your desk – it turns on the desk lights; it sees you in bed sleeping – it turns off all the lights; it sees you holding a bathrobe – it decides to turn on the bathroom lights and play some music.

With a simple configuration process and easy addition of new types of devices, it’s extremely easy to start using it.

But how does this “eye” work? Generally, a proprietary artificial intelligence (based on BLIP by Salesforce) is able to describe what the user is doing: first in general, indicating where the user is in the room and with whom, then in detail, identifying what objects the user is holding and what they’re engaged in.

Then, a proprietary algorithm is able – starting from this description – to execute the necessary actions. This algorithm is based on natural language understanding (NLU): starting from an initial description, it can generate and chain relevant actions until a stop signal is received, in a way similar to the autoregressive generation of large language models (LLMs).

In the case of more complex requests or those sent directly by the user, an OpenAI assistant comes into play, which, thanks to the art of prompt engineering, is able to handle the most difficult actions to decipher (for example, when the user asks the AI something specific through the app).

This last aspect may raise concerns regarding personal data privacy: in reality, there’s no issue, as only the description of what is happening in the room is sent to the assistant.

Over time, the goal is to eliminate the OpenAI assistant as well, by increasingly improving the proprietary algorithm.

Already from the beginning of the project, however, the OpenAI assistant has been removed for most tasks: initially it was used for everything, but this made the system slow. Now it only intervenes when strictly necessary.

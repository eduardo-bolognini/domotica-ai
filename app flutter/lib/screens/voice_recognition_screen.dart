import 'dart:async';
import 'package:flutter/cupertino.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;
import '../services/chat_service.dart';

class SpeechOverlay extends StatefulWidget {
  final VoidCallback onClose; // Callback per nascondere l'overlay

  const SpeechOverlay({Key? key, required this.onClose}) : super(key: key);

  @override
  State<SpeechOverlay> createState() => _SpeechOverlayState();
}

class _SpeechOverlayState extends State<SpeechOverlay> {
  late stt.SpeechToText _speech;
  bool _isListening = false;
  String _text = "Sto ascoltando...";
  double _confidence = 0.0;
  String _errorMessage = '';
  bool _hasError = false;

  // Timer e stopwatch per il controllo del riconoscimento
  Stopwatch _stopwatch = Stopwatch();
  Timer? _speechTimer;
  bool _hasReceivedFirstWord = false;

  @override
  void initState() {
    super.initState();
    _speech = stt.SpeechToText();
    _initSpeech();
  }

  void _initSpeech() async {
    try {
      await _speech.initialize(
        onStatus: (status) {
          print("Stato: $status");
        },
        onError: (error) {
          print("Errore: $error");
          _handleError('Errore: ${error.errorMsg}');
        },
      );
      _startListening();
    } catch (e) {
      _handleError('Errore inizializzazione: $e');
    }
  }

  void _startListening() {
    if (!_speech.isAvailable || _isListening) return;

    // Resetta i valori iniziali
    _hasReceivedFirstWord = false;
    _stopwatch.reset();
    _speechTimer?.cancel();

    setState(() {
      _isListening = true;
      _hasError = false;
      _text = "Sto ascoltando...";
    });

    _speech.listen(
      onResult: (result) {
        final hasWords = result.recognizedWords.isNotEmpty;
        if (hasWords && !_hasReceivedFirstWord) {
          _hasReceivedFirstWord = true;
          _stopwatch.start();
        }

        if (_hasReceivedFirstWord) {
          _speechTimer?.cancel();
          _speechTimer = Timer.periodic(const Duration(seconds: 1), (_) {
            setState(() {
              _stopListening();
            });
          });
        }

        setState(() {
          _text = result.recognizedWords;
          if (result.hasConfidenceRating && result.confidence > 0) {
            _confidence = result.confidence;
          }
        });
      },
      cancelOnError: true,
      listenMode: stt.ListenMode.dictation,
      localeId: 'it_IT',
    );
  }

  void _stopListening() {
    if (!_isListening) return;
    _speech.stop();
    _stopwatch.stop();
    _speechTimer?.cancel();

    setState(() {
      _hasReceivedFirstWord = false;
      _isListening = false;
    });

    print("Riconoscimento terminato");

    // Avvia il processo di chat con il testo riconosciuto
    ChatService.startChat(_text);

    widget.onClose();

  }

  void _handleError(String message) {
    setState(() {
      _isListening = false;
      _errorMessage = message;
      _hasError = true;
    });
    _speech.stop();
  }

  @override
  void dispose() {
    _speech.stop();
    _speechTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      // Non è necessaria una navigationBar in un overlay, ma puoi personalizzare l’aspetto
      child: SafeArea(
        child: Container(
          color: CupertinoColors.systemBackground.withOpacity(0.9),
          padding: const EdgeInsets.all(20.0),
          child: Column(
            mainAxisSize: MainAxisSize.min, // Adatta l’altezza al contenuto
            children: [
              if (_hasError)
                Column(
                  children: [
                    Icon(
                      CupertinoIcons.exclamationmark_triangle_fill,
                      color: CupertinoColors.systemRed,
                      size: 40,
                    ),
                    const SizedBox(height: 20),
                    Text(
                      _errorMessage,
                      style: TextStyle(
                        color: CupertinoColors.systemRed,
                        fontSize: 16,
                      ),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 20),
                    CupertinoButton(
                      child: const Text('Riprova'),
                      onPressed: _initSpeech,
                    ),
                  ],
                )
              else
                Column(
                  children: [
                    Text(
                      _text,
                      style: const TextStyle(fontSize: 20),
                      textAlign: TextAlign.center,
                    ),
                    const SizedBox(height: 20),
                    Text(
                      'Confidenza: ${(_confidence * 100).toStringAsFixed(1)}%',
                      style: const TextStyle(fontSize: 16),
                    ),
                    const SizedBox(height: 30),
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

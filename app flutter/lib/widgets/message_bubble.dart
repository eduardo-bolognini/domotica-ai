import 'dart:convert';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart'; // Puoi usare anche CupertinoPageScaffold se preferisci
import 'package:http/http.dart' as http;
import '../constants.dart';
import 'dart:async';
import '../services/auth_service.dart';


// Widget per visualizzare il bubble del messaggio, comprensivo di gestione per il tipo "question"
class MessageBubble extends StatelessWidget {
  final Map<String, dynamic> message;


  MessageBubble({Key? key, required this.message}) : super(key: key);



  @override
  Widget build(BuildContext context) {
    final isAssistant = message['sender'] == 'assistant';
    final content = message['content'];
    String? tipo;
    if (content != null && content is Map<String, dynamic>) {
      tipo = content['tipo'];
    }

    final bool load_text_content = true;

    Widget textContent;

    if (tipo == 'execution') {
      // Gestione del tipo "execution" come nel codice originale
      final List<dynamic> messagesList = content['messages'] ?? [];
      final List<dynamic> changesList = content['changes'] ?? [];
      final String? explanation = content['explanation'] as String?;




      textContent = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var msg in messagesList)
            Text(
              "${msg['type']}: ${msg['text']}",
              style: const TextStyle(fontSize: 16, color: CupertinoColors.black),
            ),
          const SizedBox(height: 8),
          if (explanation != null && explanation.isNotEmpty)
            ExplanationSection(explanation: explanation),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            children: changesList.map<Widget>((change) {
              final rawStatus = change['status'];
              int status;
              if (rawStatus is int) {
                status = rawStatus;
              } else if (rawStatus is String) {
                status = int.tryParse(rawStatus) ?? 0;
              } else {
                status = 0;
              }
              return ChangeCard(
                name: change['name'] ?? '',
                room: change['room'] ?? '',
                isActive: status == 1,
              );
            }).toList(),
          ),
        ],
      );
    } else if (tipo == 'attivazione') {
      final String baseText = "E' stata richiesta la attivazione del sistema";
      final String customMessage = (content['message'] != null &&
          content['message']
              .toString()
              .isNotEmpty)
          ? " con questo input personalizzato: ${content['message']}"
          : "";
      textContent = Text(
        "$baseText$customMessage",
        style: const TextStyle(fontSize: 16, color: CupertinoColors.white),
      );
    } else if (tipo == "answer") {
      return Container();
    } else if (tipo == 'loading') {
      textContent = const LoadingDots();
    } else if (tipo == 'question') {
      // Gestione del tipo "question":
      // Estrai i campi della domanda e il reply id (qui chiamato "reply_yo")
      final String questionText = content['question'] ?? "Domanda non disponibile";
      final String replyId = content['reply_to']?.toString() ?? "";

      textContent = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            "Domanda: $questionText",
            style: const TextStyle(fontSize: 16, color: CupertinoColors.black),
          ),
          const SizedBox(height: 8),
          // Widget per inviare la risposta
          AnswerForm(replyId: replyId),
        ],
      );
    } else {
      // Gestione di messaggi standard
      textContent = Text(
        content.toString(),
        style: const TextStyle(color: CupertinoColors.black),
      );
    }

    return Container(
      padding: const EdgeInsets.all(10),
      alignment: isAssistant ? Alignment.centerLeft : Alignment.centerRight,
      child: Column(
        crossAxisAlignment: isAssistant ? CrossAxisAlignment.start : CrossAxisAlignment.end,
        children: [
          Container(
            padding: const EdgeInsets.all(12),
            decoration: BoxDecoration(
              color: isAssistant ? CupertinoColors.systemGrey5 : CupertinoColors.activeBlue,
              borderRadius: BorderRadius.circular(16),
            ),
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.8),
            child: textContent,
          ),
        ],
      ),
    );
  }
}

/// Widget per il form di risposta alla domanda
class AnswerForm extends StatefulWidget {
  final String replyId;

  const AnswerForm({Key? key, required this.replyId}) : super(key: key);

  @override
  _AnswerFormState createState() => _AnswerFormState();
}

class _AnswerFormState extends State<AnswerForm> {
  final _controller = TextEditingController();
  bool _isSending = false;
  String? _responseMessage;

  Future<void> _sendAnswer() async {
    if (_controller.text.trim().isEmpty) return;
    setState(() {
      _isSending = true;
    });

    final Map<String, dynamic> body = {
      "answer": _controller.text.trim(),
      "id": widget.replyId,
    };

    try {
      final token = await AuthService.getToken();
      final Uri url = Uri.parse("${Constants.apiBaseUrl}/answer"); // attento: "anwer" sembra un typo
      final response = await http.post(
        url,
        headers: {"Content-Type": "application/json", "Authorization": "Bearer $token"},
        body: jsonEncode(body),
      );

      if (response.statusCode == 200) {
        setState(() {
          _responseMessage = "Risposta inviata con successo!";
        });
      } else {
        setState(() {
          _responseMessage = "Errore nell'invio (status: ${response.statusCode})";
        });
      }
    } catch (e) {
      setState(() {
        _responseMessage = "Si è verificato un errore: $e";
      });
    } finally {
      setState(() {
        _isSending = false;
      });
      _controller.clear();
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.all(8.0), // padding esterno al form
      child: Container(
        decoration: BoxDecoration(
          color: CupertinoColors.systemGrey6,
          borderRadius: BorderRadius.circular(16), // bordi arrotondati del contenitore
        ),
        child: Padding(
          padding: const EdgeInsets.all(12.0), // padding interno generale
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Padding(
                padding: EdgeInsets.only(bottom: 8.0),
                child: Text(
                  "Rispondi",
                  style: TextStyle(
                    fontSize: 18,
                    fontWeight: FontWeight.bold,
                  ),
                ),
              ),
              CupertinoTextFormFieldRow(
                controller: _controller,
                placeholder: "Scrivi la tua risposta",
                maxLines: 3,
                minLines: 1,
                expands: false,
                keyboardType: TextInputType.multiline,
                padding: const EdgeInsets.symmetric(vertical: 12, horizontal: 8),
                decoration: const BoxDecoration(
                  color: CupertinoColors.white,
                ),
              ),
              const SizedBox(height: 12),
              _isSending
                  ? const CupertinoActivityIndicator()
                  : CupertinoButton.filled(
                padding: const EdgeInsets.symmetric(vertical: 14),
                child: const Text("Invia Risposta"),
                onPressed: _sendAnswer,
              ),
              if (_responseMessage != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    _responseMessage!,
                    style: const TextStyle(
                      color: CupertinoColors.activeGreen,
                      fontSize: 14,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

}
/// Widget per la sezione "explanation" (già presente nel tuo codice)
class ExplanationSection extends StatefulWidget {
  final String explanation;

  const ExplanationSection({Key? key, required this.explanation}) : super(key: key);

  @override
  _ExplanationSectionState createState() => _ExplanationSectionState();
}

class _ExplanationSectionState extends State<ExplanationSection> {
  bool _showExplanation = false;

  void _toggleExplanation() {
    setState(() {
      _showExplanation = !_showExplanation;
    });
  }

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        CupertinoButton(
          padding: EdgeInsets.zero,
          onPressed: _toggleExplanation,
          child: Text(
            _showExplanation ? "Nascondi spiegazione" : "Mostra spiegazione",
            style: const TextStyle(fontSize: 14),
          ),
        ),
        if (_showExplanation)
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: CupertinoColors.systemGrey4,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              widget.explanation,
              style: const TextStyle(fontSize: 14, color: CupertinoColors.black),
            ),
          ),
      ],
    );
  }
}

/// Widget per visualizzare l'animazione dei 3 puntini
class LoadingDots extends StatefulWidget {
  const LoadingDots({Key? key}) : super(key: key);

  @override
  _LoadingDotsState createState() => _LoadingDotsState();
}

class _LoadingDotsState extends State<LoadingDots> {
  int dotCount = 0;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(milliseconds: 500), (Timer t) {
      setState(() {
        dotCount = (dotCount + 1) % 4; // Cicla tra 0, 1, 2, 3 puntini
      });
    });
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final dots = List.filled(dotCount, '.').join();
    return Text(
      dots,
      style: const TextStyle(fontSize: 24, color: CupertinoColors.black),
    );
  }
}

/// Widget per visualizzare una card relativa ad un cambiamento
class ChangeCard extends StatelessWidget {
  final String name;
  final String room;
  final bool isActive;

  const ChangeCard({
    Key? key,
    required this.name,
    required this.room,
    required this.isActive,
  }) : super(key: key);

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 140,
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isActive ? CupertinoColors.white : CupertinoColors.systemGrey4,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: CupertinoColors.systemGrey),
      ),
      child: Column(
        children: [
          Icon(
            CupertinoIcons.lightbulb,
            color: isActive ? CupertinoColors.systemYellow : CupertinoColors.inactiveGray,
            size: 30,
          ),
          const SizedBox(height: 8),
          Text(name, style: const TextStyle(fontWeight: FontWeight.bold)),
          Text(room),
          const SizedBox(height: 4),
          Text(
            isActive ? "Attivato" : "Spento",
            style: TextStyle(
              color: isActive ? CupertinoColors.activeGreen : CupertinoColors.destructiveRed,
            ),
          ),
        ],
      ),
    );
  }
}

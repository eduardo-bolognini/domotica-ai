import 'package:flutter/cupertino.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;
import '../services/socket_service.dart';
import '../services/chat_service.dart';
import '../services/auth_service.dart';
import 'splash_screen.dart';
import '../widgets/message_bubble.dart';
import '../constants.dart';
import 'package:porcupine_flutter/porcupine_manager.dart';
import 'package:permission_handler/permission_handler.dart';
import 'voice_recognition_screen.dart';
import 'package:flutter_tts/flutter_tts.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({Key? key}) : super(key: key);

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final TextEditingController msgController = TextEditingController();
  final SocketService socketService = SocketService();
  final List<Map<String, dynamic>> messages = <Map<String, dynamic>>[];
  final ScrollController _scrollController = ScrollController();
  late PorcupineManager _porcupineManager;
  bool _showSpeechOverlay = false;
  final FlutterTts flutterTts = FlutterTts();
  final storage = FlutterSecureStorage();
  bool _voiceModeEnabled = false;

  @override
  void initState() {
    super.initState();
    _loadVoiceModePreference();
    _initPorcupine();
    loadChat();
    socketService.init(
      onNewMessage: (dynamic msg) {
        setState(() {
          messages.add(msg);
          _speakOnCondition(msg);
        });
        _scrollToBottom();
      },
      onModifiedMessage: (dynamic msg) {
        setState(() {
          final int idx = messages.indexWhere((m) => m['id'] == msg['id']);
          if (idx != -1) messages[idx] = msg;
          _speakOnCondition(msg);
        });
      },
    );
  }

  Future<void> loadChat() async {
    try {
      final data = await ChatService.readChat();
      if (data != null && data['chat'] != null) {
        for (var msg in data['chat']) {
          _handleNewMessage(msg);
        }
        _scrollToBottom();
      }
    } catch (e) {
      print('Errore caricamento chat: $e');
    }
  }

  Future<void> _loadVoiceModePreference() async {
    final value = await storage.read(key: 'voice_mode');
    setState(() {
      _voiceModeEnabled = value == 'true';
    });
  }

  Future<void> _saveVoiceModePreference(bool enabled) async {
    await storage.write(key: 'voice_mode', value: enabled.toString());
  }

  void _handleNewMessage(dynamic msg) {
    if (!messages.any((m) => m['id'] == msg['id'])) {
      setState(() => messages.add(msg));
    }
  }

  Future<void> _speak(String text) async {
    await flutterTts.setLanguage('it-IT');
    await flutterTts.setSpeechRate(0.5);
    await flutterTts.speak(text);
  }

  void _speakOnCondition(dynamic msg) {
    if (!_voiceModeEnabled) return;
    if (msg['sender'] == 'assistant' && msg['content']?['tipo'] == 'execution') {
      final list = msg['content']['messages'] as List<dynamic>? ?? [];
      for (var m in list) {
        if (m is Map<String, dynamic> && m['type'] == 'answer' && (m['text'] as String).isNotEmpty) {
          _speak(m['text']);
          break;
        }
      }
    }
  }

  void _wakeWordCallback(int keywordIndex) async {
    if (keywordIndex == 0) {
      await _porcupineManager.stop();
      setState(() => _showSpeechOverlay = true);
    }
  }

  Future<void> _initPorcupine() async {
    if (await Permission.microphone.request().isGranted) {
      try {
        _porcupineManager = await PorcupineManager.fromKeywordPaths(
          Constants.apikey,
          [Constants.wakeWordPath],
          _wakeWordCallback,
          modelPath: Constants.modelpath,
        );
        await _porcupineManager.start();
      } catch (_) {}
    }
  }

  void sendMessage() async {
    final text = msgController.text;
    if (await ChatService.startChat(text)) {
      msgController.clear();
    } else {
      showCupertinoDialog(
        context: context,
        builder: (_) => CupertinoAlertDialog(
          title: const Text('Errore'),
          content: const Text('Impossibile avviare il processo sul server.'),
          actions: [
            CupertinoDialogAction(
              child: const Text('OK'),
              onPressed: () => Navigator.pop(context),
            ),
          ],
        ),
      );
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        final max = _scrollController.position.maxScrollExtent;
        _scrollController.jumpTo(max);
        Future.delayed(const Duration(milliseconds: 50), () {
          _scrollController.animateTo(
            max,
            duration: const Duration(milliseconds: 300),
            curve: Curves.easeOut,
          );
        });
      }
    });
  }

  Future<void> logout() async {
    try {
      final token = await AuthService.getToken();
      if (token != null) {
        await http.post(
          Uri.parse('${Constants.apiBaseUrl}/logout'),
          headers: {'Authorization': 'Bearer $token'},
        );
      }
    } catch (_) {} finally {
      await AuthService.clearCredentials();
      socketService.dispose();
      Navigator.pushAndRemoveUntil(
        context,
        CupertinoPageRoute(builder: (_) => const SplashScreen()),
            (_) => false,
      );
    }
  }

  @override
  void dispose() {
    socketService.dispose();
    _scrollController.dispose();
    msgController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return CupertinoPageScaffold(
      navigationBar: CupertinoNavigationBar(
        leading: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(CupertinoIcons.mic),
            const SizedBox(width: 6),
            CupertinoSwitch(
              value: _voiceModeEnabled,
              onChanged: (v) {
                setState(() => _voiceModeEnabled = v);
                _saveVoiceModePreference(v);
              },
            ),
          ],
        ),
        middle: const Text('Chat'),
        trailing: CupertinoButton(
          padding: EdgeInsets.zero,
          child: const Text('Logout'),
          onPressed: logout,
        ),
      ),
      child: Column(
        children: [
          Expanded(
            child: ListView.builder(
              controller: _scrollController,
              itemCount: messages.length,
              itemBuilder: (_, i) => MessageBubble(message: messages[i]),
            ),
          ),
          if (_showSpeechOverlay)
            SizedBox(
              height: 200,
              child: SpeechOverlay(
                onClose: () {
                  setState(() => _showSpeechOverlay = false);
                  _initPorcupine();
                },
              ),
            ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
            child: Row(
              children: [
                Expanded(
                  child: CupertinoTextField(
                    controller: msgController,
                    placeholder: 'Inserisci un messaggio (opzionale)',
                  ),
                ),
                CupertinoButton(
                  child: const Text('Invia'),
                  onPressed: sendMessage,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

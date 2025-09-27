import 'dart:convert';
import 'package:http/http.dart' as http;
import 'auth_service.dart';
import '../constants.dart';

class ChatService {
  /// Crea la chat sul server inviando una richiesta POST all'endpoint /api/create_chat.
  static Future<bool> createChat() async {
    final token = await AuthService.getToken();
    final res = await http.post(
      Uri.parse('${Constants.apiBaseUrl}/create_chat'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
    );
    return res.statusCode == 200;
  }

  static Future<dynamic> readChat() async {
    final token = await AuthService.getToken();
    print("token: $token");
    final url = Uri.parse('${Constants.apiBaseUrl}/read_chat');

    final response = await http.get(
      url,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
    );

    if (response.statusCode == 200) {
      print('response: ${response.body}');
      return jsonDecode(response.body);
    } else {
      print("errore");
      throw Exception('Errore nel leggere la chat: ${response.statusCode}');

    }
  }


  /// Avvia il processo della chat inviando una richiesta POST all'endpoint /api/start.
  /// Il parametro [message] è opzionale e può essere vuoto.
  static Future<bool> startChat(String message) async {
    final token = await AuthService.getToken();
    final res = await http.post(
      Uri.parse('${Constants.apiBaseUrl}/start'),
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer $token',
      },
      body: jsonEncode({'message': message}),
    );
    return res.statusCode == 200;
  }
}

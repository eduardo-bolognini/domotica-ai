import 'package:flutter/cupertino.dart';
import '../services/auth_service.dart';
import '../services/chat_service.dart';
import 'login_screen.dart';
import 'chat_screen.dart';

class SplashScreen extends StatefulWidget {
  const SplashScreen({Key? key}) : super(key: key);

  @override
  State<SplashScreen> createState() => _SplashScreenState();
}

class _SplashScreenState extends State<SplashScreen> {
  @override
  void initState() {
    super.initState();
    _autoLogin();
  }

  Future<void> _autoLogin() async {
    final credentials = await AuthService.getSavedCredentials();

    if (credentials != null) {
      final success = await AuthService.login(
        credentials['username']!,
        credentials['password']!,
      );

      if (success) {
        final chatSuccess = await ChatService.createChat();
        if (chatSuccess) {
          Navigator.pushReplacement(
            context,
            CupertinoPageRoute(builder: (_) => const ChatScreen()),
          );
          return;
        }
      }
    }

    // Qualsiasi fallimento → torna al login
    Navigator.pushReplacement(
      context,
      CupertinoPageRoute(builder: (_) => const LoginScreen()),
    );
  }

  @override
  Widget build(BuildContext context) {
    return const CupertinoPageScaffold(
      child: Center(child: CupertinoActivityIndicator()),
    );
  }
}

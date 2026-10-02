import 'dart:async';

import 'dart:io' show InternetAddressType;

import 'package:nsd/nsd.dart';

class FoundPc {
  FoundPc(this.name, this.host, this.port);
  final String name;
  final String host;
  final int port;
  Uri get base => Uri(scheme: 'http', host: host, port: port);
  @override
  bool operator ==(Object other) => other is FoundPc && other.host == host && other.port == port;
  @override
  int get hashCode => Object.hash(host, port);
}

/// Ищет компьютеры с VRCast Bridge в сети (mDNS, тип _vrcast._tcp).
class Discovery {
  Discovery(this.onChange);

  final void Function(List<FoundPc>) onChange;
  dynamic _discovery;
  final Map<String, FoundPc> _found = {};

  Future<void> start() async {
    _discovery = await startDiscovery('_vrcast._tcp', ipLookupType: IpLookupType.v4);
    _discovery.addServiceListener((Service service, ServiceStatus status) {
      final key = service.name ?? '';
      if (status == ServiceStatus.lost) {
        _found.remove(key);
      } else {
        final host = service.addresses?.where((a) => a.type == InternetAddressType.IPv4).firstOrNull?.address;
        if (host != null && service.port != null) {
          final txt = service.txt?['name'];
          final label = txt == null ? key : String.fromCharCodes(txt);
          _found[key] = FoundPc(label, host, service.port!);
        }
      }
      onChange(_found.values.toList());
    });
  }

  Future<void> stop() async {
    final current = _discovery;
    _discovery = null;
    if (current != null) await stopDiscovery(current);
  }
}

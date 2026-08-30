# infrastructure-as-effects index

10 pages. One Effect program models both your runtime code and the infrastructure it runs on — Functions carry code, Bindings wire resources into them, Phases split deploy from runtime, Layers package it all behind typed services.

| Page | File | Covers |
| --- | --- | --- |
| Infrastructure as Effects | `_overview.md` | One Effect program models both your runtime code and the infrastructure it runs on — Functions carry code, Bindings wire resources into them, Phases split deploy from runtime, Layers package it all behind typed services. |
| Bindings | `binding.md` | A Binding connects a Resource to a Worker or Lambda. One line declares the capability and generates the permissions, the configuration, and a typed client. |
| Circular Bindings | `circular-bindings.md` | How to model two services that reference each other (Worker A ↔ Worker B, Lambda ↔ Lambda) using tagged classes and Layers. |
| Custom Runtime | `custom-runtime.md` | Implement your own Function/Server resource on the Platform type — a Provider that provisions the compute and bundles the runtime Effect. |
| Event Sources | `event-sources.md` | An event source is a binding that runs your Function when something happens on a resource — one call wires the event-source mapping, the permissions, and a typed handler. |
| Functions & Servers | `functions-and-servers.md` | Workers, Lambda Functions, and Containers ship runtime code along with their infrastructure — declared with the Effectful Constructor pattern, bind what you need, return what you expose. |
| Layers | `layers.md` | A Layer defines a service contract with swappable implementations. In Alchemy, a Layer can encapsulate Resources and Bindings, so shared services carry their own infrastructure and permissions. |
| Phases | `phases.md` | Alchemy programs run in two phases — plantime/init drives the deploy, runtime handles requests. Knowing which is which is the key to writing Workers and Lambda Functions. |
| Sinks | `sinks.md` | A Sink is the write-side dual of an Event Source — a Binding that exposes a resource as an Effect Sink, batching writes into the batch API with least-privilege IAM. |
| Telemetry | `telemetry.md` | OpenTelemetry is built into every runtime — exporters are Layers, wired to resources through the binding infrastructure, built per event, and flushed as each request completes. |

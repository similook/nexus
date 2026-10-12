.PHONY: verify android apple test clean

# Always run verify before a first build or after a version bump — see core/README.md.
verify:
	./scripts/verify-api.sh

android:
	./scripts/build-android.sh

apple:
	./scripts/build-apple.sh

test:
	bash ./scripts/prepare-sing-box.sh
	go test ./nexuscore/...

clean:
	rm -rf build/

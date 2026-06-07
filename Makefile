.PHONY: test publish patch minor major

test:
	npm test

patch:
	npm version patch

minor:
	npm version minor

major:
	npm version major

publish: test
	npm publish --access public

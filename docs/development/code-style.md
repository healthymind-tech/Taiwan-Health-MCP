# 程式碼規範

## Python Style Guide
- 我們遵循 **PEP 8** 規範。
- 使用 `Black` 作為 formatter。
- 使用 `isort` 排序 imports。

## Type Hinting
所有公開函式 (Public Functions) 都必須包含型別註釋 (Type Hints)。

```python
# 正確範例
def get_user_age(name: str) -> int:
    ...
```

## Docstrings
使用 Google Style Docstrings。

```python
def function(arg1, arg2):
    """
    Summary line.

    Args:
        arg1: Description of arg1
        arg2: Description of arg2
    
    Returns:
        Description of return value
    """
    pass
```
